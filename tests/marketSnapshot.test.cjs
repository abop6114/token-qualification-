const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeMarketSnapshot } = require("../dist/normalization/marketSnapshot.js");
const { parseDexScreenerPairs } = require("../dist/providers/market/dexScreener.js");

const MINT = "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP";
const OTHER = "11111111111111111111111111111111";
const FETCHED_AT = "2026-01-02T03:04:05.000Z";

function rawPool(poolAddress, overrides = {}) {
  return {
    chainId: "solana",
    poolAddress,
    dexId: "test-dex",
    baseTokenAddress: MINT,
    quoteTokenAddress: OTHER,
    priceUsd: "0.12500",
    marketCapUsd: 1000,
    fdvUsd: 2000,
    liquidityUsd: 300,
    volumeUsd: { m5: 1, h1: 2, h6: 3, h24: 4 },
    poolCreatedAt: Date.parse("2025-12-01T00:00:00.000Z"),
    ...overrides,
  };
}

function normalize(pools) {
  return normalizeMarketSnapshot("solana", MINT, pools, FETCHED_AT);
}

function pairResponse(overrides = {}) {
  return {
    chainId: "solana",
    pairAddress: "pool-address",
    dexId: "test-dex",
    baseToken: { address: MINT },
    quoteToken: { address: OTHER },
    priceUsd: "0.12500",
    marketCap: null,
    fdv: undefined,
    liquidity: { usd: 0 },
    volume: { m5: 0, h1: 2, h6: 3, h24: 4 },
    pairCreatedAt: 1764547200000,
    ...overrides,
  };
}

test("keeps all eligible pools and chooses the pool with highest available liquidity", () => {
  const snapshot = normalize([
    rawPool("pool-a", { liquidityUsd: 100 }),
    rawPool("pool-b", { liquidityUsd: 200 }),
    rawPool("not-this-token", { baseTokenAddress: OTHER, quoteTokenAddress: "other-mint" }),
    rawPool("not-solana", { chainId: "ethereum" }),
  ]);
  assert.equal(snapshot.pools.length, 2);
  assert.equal(snapshot.primaryPoolAddress, "pool-b");
});

test("uses h24 volume to break an available-liquidity tie", () => {
  const snapshot = normalize([
    rawPool("pool-low-volume", { liquidityUsd: 200, volumeUsd: { h24: 10 } }),
    rawPool("pool-high-volume", { liquidityUsd: 200, volumeUsd: { h24: 20 } }),
  ]);
  assert.equal(snapshot.primaryPoolAddress, "pool-high-volume");
});

test("compares high-precision reported decimal liquidity without Number rounding", () => {
  const snapshot = normalize([
    rawPool("pool-lower", { liquidityUsd: "100000000000000000000.1" }),
    rawPool("pool-higher", { liquidityUsd: "100000000000000000000.2" }),
  ]);
  assert.equal(snapshot.primaryPoolAddress, "pool-higher");
});

test("uses lexicographically smallest pool address for the final tie-break", () => {
  const snapshot = normalize([
    rawPool("pool-z", { liquidityUsd: 200, volumeUsd: { h24: 20 } }),
    rawPool("pool-a", { liquidityUsd: 200, volumeUsd: { h24: 20 } }),
  ]);
  assert.equal(snapshot.primaryPoolAddress, "pool-a");
});

test("missing liquidity and h24 volume sort behind reported values and remain unavailable", () => {
  const snapshot = normalize([
    rawPool("pool-missing", { liquidityUsd: null, volumeUsd: {} }),
    rawPool("pool-zero", { liquidityUsd: 0, volumeUsd: { h24: 0 } }),
  ]);
  assert.equal(snapshot.primaryPoolAddress, "pool-zero");
  assert.deepEqual(snapshot.pools[1].liquidityUsd, {
    status: "unavailable", value: null, reason: "not_reported",
  });
  assert.deepEqual(snapshot.pools[1].volumeUsd.h24, {
    status: "unavailable", value: null, reason: "not_reported",
  });
  assert.deepEqual(snapshot.pools[0].liquidityUsd, {
    status: "available", value: "0", basis: "provider_reported", sourceField: "liquidity.usd",
  });
  assert.deepEqual(snapshot.pools[0].volumeUsd.h24, {
    status: "available", value: "0", basis: "provider_reported", sourceField: "volume.h24",
  });
});

test("null and missing market cap/FDV stay explicitly unavailable", () => {
  const [pool] = normalize([rawPool("pool-a", { marketCapUsd: null, fdvUsd: null })]).pools;
  assert.deepEqual(pool.marketCapUsd, { status: "unavailable", value: null, reason: "not_reported" });
  assert.deepEqual(pool.fdvUsd, { status: "unavailable", value: null, reason: "not_reported" });
  const parsed = parseDexScreenerPairs([pairResponse()])[0];
  assert.equal(parsed.marketCapUsd, null);
  assert.equal(parsed.fdvUsd, null);
});

test("collapses identical duplicate observations by chain and pool address", () => {
  const snapshot = normalize([rawPool("pool-duplicate"), rawPool("pool-duplicate")]);
  assert.equal(snapshot.pools.length, 1);
  assert.equal(snapshot.pools[0].liquidityUsd.value, "300");
});

test("collapses semantically equivalent numeric duplicate observations", () => {
  const numeric = rawPool("pool-numeric-equivalent", { liquidityUsd: 300, priceUsd: "0.12500" });
  const string = rawPool("pool-numeric-equivalent", { liquidityUsd: "300.0", priceUsd: 0.125 });
  const forward = normalize([numeric, string]);
  const reverse = normalize([string, numeric]);
  assert.equal(forward.pools.length, 1);
  assert.deepEqual(forward, reverse);
});

test("rejects conflicting duplicate liquidity observations in either order", () => {
  const first = rawPool("pool-conflict", { liquidityUsd: 300 });
  const second = rawPool("pool-conflict", { liquidityUsd: 301 });
  assert.throws(() => normalize([first, second]), /Conflicting duplicate market observations/);
  assert.throws(() => normalize([second, first]), /Conflicting duplicate market observations/);
});

test("rejects conflicting duplicate pool identity observations", () => {
  const first = rawPool("pool-conflict", { dexId: "dex-a" });
  const second = rawPool("pool-conflict", { dexId: "dex-b" });
  assert.throws(() => normalize([first, second]), /Conflicting duplicate market observations/);
});

test("a valid mint with no pools is successful market data with an empty pool list", () => {
  const snapshot = normalize([]);
  assert.deepEqual(snapshot.pools, []);
  assert.equal(snapshot.primaryPoolAddress, null);
  assert.deepEqual(snapshot.pools, []);
});

test("market fields preserve reported decimal strings and zero without invented precision", () => {
  const [pool] = normalize([rawPool("pool-a", { priceUsd: "0.123400", liquidityUsd: 0 })]).pools;
  assert.equal(pool.priceUsd.value, "0.123400");
  assert.equal(pool.liquidityUsd.value, "0");
  assert.equal(pool.provenance.provider, "dexscreener");
  assert.equal(pool.provenance.fetchedAt, FETCHED_AT);
  assert.equal(pool.provenance.sourceUpdatedAt, null);
});

test("pool creation time is distinct from token creation age and lifecycle remains unknown", () => {
  const snapshot = normalize([rawPool("pool-a")]);
  assert.deepEqual(snapshot.pools[0].poolCreatedAt, {
    status: "available",
    value: "2025-12-01T00:00:00.000Z",
    basis: "provider_reported",
    sourceField: "pairCreatedAt",
  });
  assert.deepEqual(snapshot.tokenCreatedAt, {
    status: "unavailable", value: null, reason: "no_creation_evidence",
  });
  assert.deepEqual(snapshot.tokenAgeSeconds, {
    status: "unavailable", value: null, reason: "no_creation_evidence",
  });
  assert.deepEqual(snapshot.lifecycle, { state: "unknown", basis: "unknown", evidence: null });
});

test("malformed numeric provider data is rejected instead of normalized as missing", () => {
  assert.throws(() => parseDexScreenerPairs([pairResponse({ priceUsd: "NaN" })]), /malformed priceUsd/);
  assert.throws(() => parseDexScreenerPairs([pairResponse({ volume: { h24: Infinity } })]), /malformed volume.h24/);
  assert.throws(() => parseDexScreenerPairs({}), /malformed token-pairs response/);
});

test("base-side mint uses quote token as counter token and keeps token-oriented metrics", () => {
  const [pool] = normalize([rawPool("pool-a")]).pools;
  assert.equal(pool.counterTokenAddress, OTHER);
  assert.deepEqual(pool.priceUsd, {
    status: "available", value: "0.12500", basis: "provider_reported", sourceField: "priceUsd",
  });
  assert.deepEqual(pool.marketCapUsd, {
    status: "available", value: "1000", basis: "provider_reported", sourceField: "marketCap",
  });
  assert.deepEqual(pool.fdvUsd, {
    status: "available", value: "2000", basis: "provider_reported", sourceField: "fdv",
  });
});

test("quote-side mint uses base token as counter token and marks token metrics orientation unsupported", () => {
  const [pool] = normalize([rawPool("pool-quote-side", {
    baseTokenAddress: OTHER,
    quoteTokenAddress: MINT,
    priceUsd: "1.25",
    marketCapUsd: 1250,
    fdvUsd: 1500,
    liquidityUsd: 900,
    volumeUsd: { m5: 1, h1: 2, h6: 3, h24: 4 },
  })]).pools;
  assert.equal(pool.counterTokenAddress, OTHER);
  for (const field of [pool.priceUsd, pool.marketCapUsd, pool.fdvUsd]) {
    assert.deepEqual(field, { status: "unavailable", value: null, reason: "orientation_unsupported" });
  }
  assert.equal(pool.liquidityUsd.value, "900");
  assert.equal(pool.volumeUsd.h24.value, "4");
});
