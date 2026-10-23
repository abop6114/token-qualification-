const assert = require("node:assert/strict");
const { test } = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createPublicReportUatServer, parseUatPort } = require("../dist/uat/publicReportUatServer.js");
const credentials = { TA_UAT_USERNAME: "offline-tester", TA_UAT_PASSWORD: "synthetic-test-password-only-123456789" };
const authorization = "Basic " + Buffer.from(`${credentials.TA_UAT_USERNAME}:${credentials.TA_UAT_PASSWORD}`).toString("base64");
const root = path.resolve(__dirname, "..");

async function withServer(run) {
  const server = await createPublicReportUatServer(credentials);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: route,
      method: options.method ?? "GET", headers: options.headers ?? { Authorization: authorization } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end();
  });
  try { await run(request); } finally { await new Promise(resolve => server.close(resolve)); }
}

test("UAT rejects absent/invalid credentials and PORT without revealing input", async () => {
  for (const env of [{}, { ...credentials, TA_UAT_USERNAME: "a:b" }, { ...credentials, TA_UAT_PASSWORD: "short" },
    { ...credentials, TA_UAT_PASSWORD: "x".repeat(129) }, { ...credentials, TA_UAT_PASSWORD: "x".repeat(32) + "\n" }]) {
    await assert.rejects(createPublicReportUatServer(env), { message: "UAT configuration invalid." });
  }
  for (const port of [undefined, "", "0", "-1", "65536", "3.5", " 123", "00123", "NaN"]) assert.throws(() => parseUatPort(port));
  assert.equal(parseUatPort("10000"), 10000); assert.equal(parseUatPort("65535"), 65535);
});

test("UAT authenticates every asset and route response before dispatch", async () => {
  await withServer(async request => {
    for (const route of ["/", "/styles.css", "/app.js", "/public-report.json", "/.env", "/api/report"]) {
      const response = await request(route, { headers: {} });
      assert.equal(response.status, 401);
      assert.equal(response.body, "Authentication required.");
      assert.match(response.headers["www-authenticate"], /^Basic /);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["referrer-policy"], "no-referrer");
      assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
    }
    assert.equal((await request("/api/report", { method: "POST", headers: {} })).status, 401);
  });
});

test("authenticated assets preserve exact synthetic fixture and security headers", async () => {
  await withServer(async request => {
    for (const route of ["/", "/styles.css", "/app.js", "/public-report.json"]) {
      const response = await request(route);
      assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["referrer-policy"], "no-referrer");
      assert.match(response.headers["content-security-policy"], /connect-src 'self'/);
      assert.ok(response.body.length > 0);
    }
    const html = (await request("/")).body;
    assert.match(html, /Synthetic data/); assert.doesNotMatch(html, /<form|id="asset-address"|Generate evidence report/);
    const report = (await request("/public-report.json")).body;
    assert.equal(report, fs.readFileSync(path.join(root, "src/dev/public-report-demo/public-report.json"), "utf8"));
    assert.doesNotMatch(report, /numeratorRaw|denominatorRaw|rawOwnerAuthorities|requestObservations|Bearer /);
    assert.equal((await request("/public-report.json", { method: "HEAD" })).body, "");
  });
});

test("no live route exists even with forged Host/Origin; unsupported methods and paths fail safely", async () => {
  await withServer(async request => {
    for (const host of ["127.0.0.1:4173", "uat.onrender.com", "uat.tokenanatomy.app"]) {
      const response = await request("/api/report", { method: "POST", headers: { Authorization: authorization, Host: host, Origin: `http://${host}` } });
      assert.equal(response.status, 405); assert.equal(response.body, "Method not allowed.");
    }
    for (const method of ["PUT", "DELETE", "OPTIONS", "PATCH"]) assert.equal((await request("/", { method })).status, 405);
    for (const route of ["/.env", "/src/cli.ts", "/api/report", "/../README.md", "//public-report.json"]) assert.equal((await request(route)).status, 404);
    for (const route of ["/%2e%2e/README.md", "/%ZZ", "/..\\README.md", "http://evil.invalid/"]) assert.equal((await request(route)).status, 400);
  });
});

test("Basic header is bounded, canonical, and rejects duplicate credentials without leaks", async () => {
  await withServer(async request => {
    for (const header of ["Bearer secret", "Basic !!!", "Basic " + "A".repeat(1025), authorization + "=", [authorization, authorization]]) {
      const response = await request("/public-report.json", { headers: { Authorization: header } });
      assert.equal(response.status, 401); assert.equal(response.body, "Authentication required.");
      assert.ok(!JSON.stringify(response).includes(credentials.TA_UAT_PASSWORD));
    }
  });
});

test("global failed-authentication throttle is bounded and cannot be bypassed using forwarded headers", async () => {
  await withServer(async request => {
    for (let i = 0; i < 10; i++) assert.equal((await request("/", { headers: { "X-Forwarded-For": `192.0.2.${i}` } })).status, 401);
    const response = await request("/", { headers: { Authorization: authorization, "X-Forwarded-For": "198.51.100.1" } });
    assert.equal(response.status, 429); assert.equal(response.body, "Access temporarily limited.");
    assert.ok(Number(response.headers["retry-after"]) >= 1 && Number(response.headers["retry-after"]) <= 60);
  });
});

test("asset loading fails closed with sanitized errors before a server is returned", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    require('node:fs/promises').readFile = async () => { throw Error('PRIVATE_PATH_SECRET'); };
    const {createPublicReportUatServer} = require('./dist/uat/publicReportUatServer.js');
    assert.rejects(createPublicReportUatServer(${JSON.stringify(credentials)}), {message:'UAT assets unavailable.'})
      .catch(() => {process.exitCode=1});
  `], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});

test("UAT construction has no external network or application/provider/database imports", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const Module = require('node:module'); const original = Module._load;
    Module._load = function(name, ...args) {
      if (/application|providers|platform[\\\\/]database|^pg$/.test(name)) throw Error('forbidden import');
      return original.call(this, name, ...args);
    };
    require('node:net').Socket.prototype.connect = () => {throw Error('network forbidden')};
    require('node:tls').connect = () => {throw Error('network forbidden')};
    global.fetch = () => {throw Error('network forbidden')};
    require('./dist/uat/publicReportUatServer.js').createPublicReportUatServer(${JSON.stringify(credentials)})
      .then(server => assert.equal(server.listening,false)).catch(() => {process.exitCode=1});
  `], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0); assert.equal(result.stderr, ""); assert.equal(result.stdout, "");
});

test("executable startup reports a fixed error without credentials or a stack", () => {
  const result = spawnSync(process.execPath, ["dist/uat/publicReportUatServer.js"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PORT: "10000", TA_UAT_USERNAME: "", TA_UAT_PASSWORD: "synthetic-secret" },
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, "UAT startup failed.\n");
});
