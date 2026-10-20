const assert = require("node:assert/strict");
const { test } = require("node:test");
const { performance } = require("node:perf_hooks");
const { generateSolanaLivePublicReport, SOLANA_LIVE_PUBLIC_REPORT_DEADLINE_MS } = require("../dist/application/solanaLivePublicReportService.js");
const { createSolanaTokenEvidenceAdmissionController } = require("../dist/application/solanaTokenEvidenceAdmissionController.js");
const { createSolanaProviderRequestBudgetController } = require("../dist/application/solanaProviderRequestBudgetController.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");

const MINT = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const TOKEN_2022 = SOLANA_TOKEN_PROGRAM_IDS["token-2022"];
const SPL = SOLANA_TOKEN_PROGRAM_IDS["spl-token"];
function environment() {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "offline-test-only";
  return () => previous === undefined ? delete process.env.HELIUS_API_KEY : process.env.HELIUS_API_KEY = previous;
}
function rpcPayload(id, result) { return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "Content-Type": "application/json" } }); }
function makeFixture(options = {}) {
  let calls = 0;
  let holderRequest = 0;
  const holderPages = options.holderPages ?? 1;
  const fetchImpl = async (input, init = {}) => {
    calls += 1;
    const url = String(input);
    if (url.includes("dexscreener.com")) {
      if (options.unsupportedOrientation) return new Response(JSON.stringify([{ chainId: "solana", pairAddress: "synthetic-pool", dexId: "synthetic",
        baseToken: { address: "11111111111111111111111111111111" }, quoteToken: { address: MINT }, priceUsd: "1", marketCap: "20", fdv: "30", liquidity: { usd: 10 }, volume: { h24: 5 } }]), { status: 200 });
      return new Response(JSON.stringify(options.withMarket ? [{ chainId: "solana", pairAddress: "synthetic-pool", dexId: "synthetic",
        baseToken: { address: options.mint ?? MINT }, quoteToken: { address: "11111111111111111111111111111111" }, priceUsd: "1", marketCap: "20", fdv: "30", liquidity: { usd: 10 }, volume: { h24: 5 } }] : []), { status: 200 });
    }
    const body = JSON.parse(init.body);
    if (body.method === "getAccountInfo") {
      const data = Buffer.alloc(options.token2022 ? 170 : 82);
      data.writeBigUInt64LE(1000n, 36); data[44] = 2; data[45] = 1;
      if (options.token2022) { data[165] = 1; data.writeUInt16LE(1, 166); data.writeUInt16LE(0, 168); }
      const owner = options.notMint ? "11111111111111111111111111111111" : options.token2022 ? TOKEN_2022 : SPL;
      return rpcPayload(1, { context: { slot: 100 }, value: { owner, data: [data.toString("base64"), "base64"] } });
    }
    if (body.method === "getProgramAccountsV2") {
      holderRequest += 1;
      const pageIndex = holderRequest - 1;
      const paginationKey = holderRequest < holderPages || options.continueAtCap && holderRequest === holderPages ? "A".repeat(holderRequest + 1) : null;
      return rpcPayload("token-accounts", { context: { slot: 101 + pageIndex }, value: { accounts: [], paginationKey } });
    }
    throw new Error("unexpected fixture URL");
  };
  return { fetchImpl, getCalls: () => calls };
}
function dependencies(fixture, options = {}) {
  return { fetchImpl: fixture.fetchImpl,
    admissionPolicy: options.admissionPolicy ?? createSolanaTokenEvidenceAdmissionController({ maxConcurrentExecutions: 1, initiallyEnabled: true }),
    providerRequestBudgetController: options.budget ?? createSolanaProviderRequestBudgetController({ capacity: 220, initiallyEnabled: true }) };
}
async function run(input, fixtureOptions = {}, dependencyOptions = {}, signal) {
  const restore = environment();
  try {
    const fixture = makeFixture({ ...fixtureOptions, mint: input.assetAddress });
    const deps = dependencies(fixture, dependencyOptions);
    const result = await generateSolanaLivePublicReport(input, deps, signal);
    return { result, fixture, deps };
  } finally { restore(); }
}

test("valid address uses three protected offline fetches, no history, and returns only the sanitized public report", async () => {
  const started = performance.now();
  const { result, fixture, deps } = await run({ chain: "solana", assetAddress: MINT });
  const elapsed = performance.now() - started;
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(fixture.getCalls(), 3);
  assert.equal(result.report.token.assetId, MINT);
  assert.equal(result.report.freshness.state, "current_observation");
  assert.equal(result.report.analystReview.disposition, "not_applicable");
  assert.deepEqual(result.report.analystReview.restrictions, []);
  assert.equal(JSON.stringify(result).includes("operationalTelemetry"), false);
  assert.equal(JSON.stringify(result).includes("holderStructure"), false);
  assert.equal(deps.providerRequestBudgetController.getStatus().consumed, 3);
  assert.equal(JSON.stringify(result).includes("historicalTransactions"), false);
  console.log(`SYNTHETIC_LIVE_E2E requests=${fixture.getCalls()} outputBytes=${Buffer.byteLength(JSON.stringify(result.report), "utf8")} elapsedMs=${elapsed.toFixed(3)}`);
});

test("invalid address and unexpected request fields are rejected before provider dispatch", async () => {
  const restore = environment();
  try {
    const fixture = makeFixture(); const deps = dependencies(fixture);
    assert.equal((await generateSolanaLivePublicReport({ chain: "solana", assetAddress: "not-a-key" }, deps)).valid, false);
    assert.equal((await generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT, metrics: [] }, deps)).valid, false);
    assert.equal((await generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT, historicalTransactions: { status: "requested" } }, deps)).valid, false);
    assert.equal(fixture.getCalls(), 0);
  } finally { restore(); }
});

test("budget exhaustion rejects before any provider invocation", async () => {
  const restore = environment();
  try {
    const fixture = makeFixture(); const budget = createSolanaProviderRequestBudgetController({ capacity: 21, initiallyEnabled: true });
    const result = await generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT }, dependencies(fixture, { budget }));
    assert.equal(result.valid, false); assert.equal(result.error.code, "budget_exhausted");
    assert.equal(fixture.getCalls(), 0); assert.equal(budget.getStatus().consumed, 0);
  } finally { restore(); }
});

test("maximum holder pagination remains within the 22-fetch envelope and partial evidence is retained", async () => {
  const restore = environment();
  try {
    const fixture = makeFixture({ holderPages: 20, continueAtCap: true, mint: MINT });
    const budget = createSolanaProviderRequestBudgetController({ capacity: 220, initiallyEnabled: true });
    const result = await generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT }, dependencies(fixture, { budget }));
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(fixture.getCalls(), 22);
    assert.equal(budget.getStatus().consumed, 22);
    const holders = result.report.sections.find((section) => section.id === "holders");
    assert.equal(holders.completeness, "partial");
    assert.ok(holders.limitationCodes.includes("partial_enumeration"));
  } finally { restore(); }
});

test("unsupported mint evidence fails closed and unsupported pool orientation stays unavailable", async () => {
  const missing = await run({ chain: "solana", assetAddress: MINT }, { notMint: true });
  assert.equal(missing.result.valid, false); assert.equal(missing.result.error.code, "evidence_unavailable");
  const wrongPool = await run({ chain: "solana", assetAddress: MINT }, { unsupportedOrientation: true });
  assert.equal(wrongPool.result.valid, true);
  const price = wrongPool.result.report.sections.find((section) => section.id === "market").fields.find((field) => field.id === "market.price");
  assert.equal(price.evidenceState, "unavailable"); assert.equal(price.visibility, "withheld");
});

test("live PYUSD does not inherit saved-case analyst restrictions and valuation stays technical-only", async () => {
  const { result } = await run({ chain: "solana", assetAddress: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" }, { withMarket: true });
  assert.equal(result.valid, true);
  assert.deepEqual(result.report.analystReview.restrictions, []);
  for (const id of ["market.market_cap", "market.fdv"]) {
    assert.equal(result.report.summary.some((field) => field.id === id), false);
    assert.equal(result.report.technicalDetails.find((field) => field.id === id).visibility, "technical_details");
  }
});

test("Token-2022 extension inventory stays presence-only and D10-withheld valuation is redacted", async () => {
  const { result } = await run({ chain: "solana", assetAddress: MINT }, { token2022: true });
  assert.equal(result.valid, true);
  const extension = result.report.sections.find((section) => section.id === "token_controls").fields.find((field) => field.id === "token_controls.extension_inventory_summary");
  assert.match(extension.value, /presence only/);
  for (const id of ["market.market_cap", "market.fdv"]) {
    const valuation = result.report.technicalDetails.find((field) => field.id === id);
    assert.equal(valuation.visibility, "withheld");
    assert.equal(Object.hasOwn(valuation, "value"), false);
  }
  const serialized = JSON.stringify(result.report);
  assert.equal(serialized.includes("extensionTypeId"), false);
  assert.equal(serialized.includes("numeratorRaw"), false);
  assert.equal(SOLANA_LIVE_PUBLIC_REPORT_DEADLINE_MS, 60_000);
});

test("one active analysis is admitted; duplicate work is rejected", async () => {
  const restore = environment();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const base = makeFixture();
  const fetchImpl = async (...args) => { entered(); await waiting; return base.fetchImpl(...args); };
  const admission = createSolanaTokenEvidenceAdmissionController({ maxConcurrentExecutions: 1, initiallyEnabled: true });
  const budget = createSolanaProviderRequestBudgetController({ capacity: 220, initiallyEnabled: true });
  const deps = { ...dependencies({ fetchImpl }, { admissionPolicy: admission, budget }) };
  try {
    const first = generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT }, deps);
    await enteredPromise;
    const second = await generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT }, deps);
    assert.equal(second.valid, false); assert.equal(second.error.code, "admission_rejected");
    release();
    assert.equal((await first).valid, true);
  } finally { release(); restore(); }
});

test("caller cancellation during active fetch returns no report and preserves dispatch accounting", async () => {
  const restore = environment();
  const controller = new AbortController(); let invoked = false;
  const fetchImpl = async (_url, init) => {
    invoked = true;
    return await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  };
  try {
    const budget = createSolanaProviderRequestBudgetController({ capacity: 220, initiallyEnabled: true });
    const pending = generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT }, dependencies({ fetchImpl }, { budget }), controller.signal);
    while (!invoked) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await pending;
    assert.equal(result.valid, false); assert.equal(result.error.code, "cancelled");
    assert.equal(Object.hasOwn(result, "report"), false);
    assert.equal(budget.getStatus().consumed, 1);
  } finally { restore(); }
});

test("pre-cancelled request dispatches nothing and the 60-second deadline returns no partial report", async () => {
  const restore = environment();
  const preAborted = new AbortController(); preAborted.abort();
  const fixture = makeFixture(); const deps = dependencies(fixture);
  const before = await generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT }, deps, preAborted.signal);
  assert.equal(before.valid, false); assert.equal(before.error.code, "cancelled"); assert.equal(fixture.getCalls(), 0);

  const realSetTimeout = global.setTimeout; const realClearTimeout = global.clearTimeout;
  global.setTimeout = (callback, delay, ...args) => delay === SOLANA_LIVE_PUBLIC_REPORT_DEADLINE_MS
    ? (queueMicrotask(() => callback(...args)), realSetTimeout(() => {}, 2 ** 30))
    : realSetTimeout(callback, delay, ...args);
  try {
    const timedFixture = makeFixture();
    const timed = await generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT }, dependencies(timedFixture));
    assert.equal(timed.valid, false); assert.equal(timed.error.code, "deadline_exceeded");
    assert.equal(Object.hasOwn(timed, "report"), false);
    assert.equal(timedFixture.getCalls(), 0);
  } finally { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; restore(); }
});

test("provider failure messages are sanitized and external network URLs are never used by the fixture", async () => {
  const restore = environment(); const urls = [];
  try {
    const fetchImpl = async (input) => { urls.push(String(input)); throw new Error("secret provider detail https://secret.invalid"); };
    const result = await generateSolanaLivePublicReport({ chain: "solana", assetAddress: MINT }, dependencies({ fetchImpl }));
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes("secret provider detail"), false);
    assert.equal(JSON.stringify(result).includes("secret.invalid"), false);
    assert.ok(urls.every((url) => url.startsWith("https://mainnet.helius-rpc.com/") || url.startsWith("https://api.dexscreener.com/")));
  } finally { restore(); }
});
