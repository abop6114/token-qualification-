const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const {
  getSolanaMintMarkets,
  DexScreenerProviderError,
} = require("../dist/providers/market/dexScreener.js");

const MINT = "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP";
const SECRET = "sentinel-provider-secret";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function pair() {
  return {
    chainId: "solana",
    pairAddress: "pool-address",
    dexId: "test-dex",
    baseToken: { address: MINT },
    quoteToken: { address: "11111111111111111111111111111111" },
    priceUsd: "0.25",
    liquidity: { usd: 12 },
    volume: { h24: 3 },
  };
}

function assertSanitized(error, category) {
  assert.ok(error instanceof DexScreenerProviderError);
  assert.equal(error.category, category);
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("provider-secret-body"), false);
  assert.equal(serialized.includes("https://"), false);
  assert.equal("cause" in error, false);
}

test("DEX Screener adapter preserves normalized success and valid empty results", async () => {
  let calls = 0;
  let requestUrl;
  let requestSignal;
  const found = await getSolanaMintMarkets(MINT, async (url, init) => {
    calls += 1;
    requestUrl = url;
    requestSignal = init.signal;
    return response([pair()]);
  }, 500);
  assert.equal(found.length, 1);
  assert.equal(found[0].poolAddress, "pool-address");
  assert.equal(found[0].priceUsd, "0.25");
  assert.match(requestUrl, /token-pairs\/v1\/solana\//);
  assert.equal(requestSignal.aborted, false);

  const empty = await getSolanaMintMarkets(MINT, async () => {
    calls += 1;
    return response([]);
  }, 500);
  assert.deepEqual(empty, []);
  assert.equal(calls, 2);
});

test("invalid timeout fails before a DEX Screener request", async () => {
  let calls = 0;
  await assert.rejects(getSolanaMintMarkets(MINT, async () => { calls += 1; }, -1), (error) => {
    assertSanitized(error, "configuration_error");
    return true;
  });
  assert.equal(calls, 0);
});

test("unexpected internal response-object exceptions are not relabeled as provider failures", async () => {
  const internalError = new Error("internal response adapter bug");
  const faultyResponse = Object.defineProperty({}, "ok", {
    get() { throw internalError; },
  });
  await assert.rejects(getSolanaMintMarkets(MINT, async () => faultyResponse, 500), (error) => error === internalError);
});

test("DEX Screener HTTP, transport, and malformed failures are sanitized without retries", async () => {
  const failures = [
    ["http_error", async () => response({ body: "provider-secret-body" }, 429)],
    ["transport_error", async () => { throw new Error(`${SECRET} https://provider/?token=${SECRET}`); }],
    ["malformed_response", async () => ({ ok: true, status: 200, json: async () => { throw new Error(`${SECRET} provider-secret-body`); } })],
    ["malformed_response", async () => response({ malformed: true })],
    ["malformed_response", async () => response([{ ...pair(), priceUsd: "1\n" }])],
    ["malformed_response", async () => response([{ ...pair(), priceUsd: "1\r\n" }])],
  ];
  for (const [category, fetchImpl] of failures) {
    let calls = 0;
    await assert.rejects(getSolanaMintMarkets(MINT, async (...args) => {
      calls += 1;
      return fetchImpl(...args);
    }, 500), (error) => {
      assertSanitized(error, category);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("DEX Screener timeout aborts the request, is sanitized, and is not retried", async () => {
  let calls = 0;
  let signal;
  await assert.rejects(getSolanaMintMarkets(MINT, (_url, init) => {
    calls += 1;
    signal = init.signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error(SECRET)), { once: true });
    });
  }, 10), (error) => {
    assertSanitized(error, "request_timeout");
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test("DEX Screener clears its timeout after normal completion", async () => {
  let signal;
  await getSolanaMintMarkets(MINT, (_url, init) => {
    signal = init.signal;
    return Promise.resolve(response([]));
  }, 20);
  await delay(35);
  assert.equal(signal.aborted, false);
});
