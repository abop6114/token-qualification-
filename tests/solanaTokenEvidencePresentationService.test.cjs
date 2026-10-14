const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  generateSolanaTokenEvidencePresentation,
} = require("../dist/application/solanaTokenEvidencePresentationService.js");
const {
  SolanaTokenEvidenceReportRequestError,
} = require("../dist/application/solanaTokenEvidenceReport.js");
const { SolanaAccountProviderError } = require("../dist/providers/solana/heliusRpc.js");
const { DexScreenerProviderError } = require("../dist/providers/market/dexScreener.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { decodeSolanaPublicKey, encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const MINT = key(90);
const HOLDER = key(4);
const TOKEN_ACCOUNT = key(5);
const FETCHED_AT = "2026-10-13T15:00:00.000Z";
const REQUEST = { chain: "solana", assetAddress: MINT, historicalTransactions: { status: "not_requested" } };

function mintAccount(owner = SOLANA_TOKEN_PROGRAM_IDS["spl-token"], supply = 1_000_000n) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(supply, 36);
  data[44] = 6;
  data[45] = 1;
  return { requestedAddress: MINT, owner, dataBase64: data.toString("base64") };
}

function tokenAccount(balance = 100n) {
  const data = Buffer.alloc(165);
  data.set(Buffer.from(decodeSolanaPublicKey(MINT)), 0);
  data.set(Buffer.from(decodeSolanaPublicKey(HOLDER)), 32);
  data.writeBigUInt64LE(balance, 64);
  data[108] = 1;
  return {
    address: TOKEN_ACCOUNT,
    programOwner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"],
    dataBase64: data.toString("base64"),
    reportedSpace: data.length,
  };
}

function holderAcquisition(accounts = [tokenAccount()], completeness = "complete") {
  const partial = completeness === "partial";
  return {
    status: "available",
    completeness,
    stopReason: partial ? "request_timeout" : "provider_terminated",
    configuredMaxPages: 20,
    requestedPageSize: 5000,
    pages: [{ accounts, paginationKey: partial ? "2" : null, contextSlot: 100 }],
  };
}

function pool(overrides = {}) {
  return {
    chainId: "solana",
    poolAddress: key(20),
    dexId: "test-dex",
    baseTokenAddress: MINT,
    quoteTokenAddress: key(21),
    priceUsd: "0.1",
    marketCapUsd: "100000",
    fdvUsd: "100000",
    liquidityUsd: "5000",
    volumeUsd: { h24: "1000" },
    poolCreatedAt: null,
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    getAccount: async () => mintAccount(),
    getMarkets: async () => [pool()],
    getTokenAccountPages: async () => holderAcquisition(),
    now: () => new Date(FETCHED_AT),
    ...overrides,
  };
}

function field(section, id) {
  return section.fields.find((entry) => entry.id === id);
}

test("successful composition returns the complete versioned presentation", async () => {
  const result = await generateSolanaTokenEvidencePresentation(REQUEST, dependencies());

  assert.equal(result.schemaVersion, "solana-token-evidence-presentation-v1");
  assert.equal(result.sourceReportSchemaVersion, "solana-token-evidence-report-v1");
  assert.equal(result.chain, "solana");
  assert.equal(result.token.requestedMintAddress, MINT);
  assert.deepEqual(result.sections.map((section) => section.id), ["identity_mint", "market", "holders", "historical"]);
  assert.ok(result.limitations.some((item) => item.includes("not an atomic")));

  const identity = result.sections[0];
  assert.equal(field(identity, "identity.raw_supply").rawValue, "1000000");
  assert.equal(field(identity, "identity.raw_supply").unit, "raw token units");
  const market = result.sections[1];
  assert.equal(market.sourceStatus.status, "present");
  assert.equal(market.pools.length, 1);
  assert.equal(market.pools[0].provenance.provider, "dexscreener");
  assert.equal(field({ fields: market.pools[0].fields }, "market.price_usd").value, "0.1");
  const holders = result.sections[2];
  assert.equal(holders.sourceStatus.status, "present");
  assert.equal(holders.completeness, "complete");
  assert.equal(field(holders, "holders.observed_positive_balance_raw").rawValue, "100");
  assert.ok(holders.limitations.some((item) => item.includes("owner authorities")));
});

test("each eligible acquisition dependency is invoked once and acquisition is not duplicated", async () => {
  const calls = { account: 0, markets: 0, holders: 0 };
  const acquisition = holderAcquisition([tokenAccount()], "complete");
  const result = await generateSolanaTokenEvidencePresentation(REQUEST, dependencies({
    getAccount: async () => { calls.account += 1; return mintAccount(); },
    getMarkets: async () => { calls.markets += 1; return [pool()]; },
    getTokenAccountPages: async () => { calls.holders += 1; return structuredClone(acquisition); },
  }));

  assert.deepEqual(calls, { account: 1, markets: 1, holders: 1 });
  assert.equal(result.sections[2].sourceStatus.status, "present");
});

test("history not requested stays explicit and performs no historical acquisition", async () => {
  let pageCalls = 0;
  let transactionCalls = 0;
  const result = await generateSolanaTokenEvidencePresentation(REQUEST, dependencies({
    fetchHistoricalPage: async () => { pageCalls += 1; throw new Error("must not be called"); },
    fetchTransaction: async () => { transactionCalls += 1; throw new Error("must not be called"); },
  }));

  assert.equal(result.sections[3].sourceStatus.status, "not_requested");
  assert.equal(pageCalls, 0);
  assert.equal(transactionCalls, 0);
});

test("unresolved mint preserves identity and skips every downstream acquisition", async () => {
  let marketCalls = 0;
  let holderCalls = 0;
  const result = await generateSolanaTokenEvidencePresentation(REQUEST, dependencies({
    getAccount: async () => null,
    getMarkets: async () => { marketCalls += 1; return []; },
    getTokenAccountPages: async () => { holderCalls += 1; return holderAcquisition(); },
  }));

  assert.equal(field(result.sections[0], "identity.account_exists").value, false);
  assert.equal(result.sections[1].sourceStatus.status, "not_attempted");
  assert.equal(result.sections[2].sourceStatus.status, "not_attempted");
  assert.equal(result.sections[3].sourceStatus.status, "not_requested");
  assert.equal(marketCalls, 0);
  assert.equal(holderCalls, 0);
});

test("recognized market provider failure remains unavailable while other evidence is preserved", async () => {
  let holderCalls = 0;
  const result = await generateSolanaTokenEvidencePresentation(REQUEST, dependencies({
    getMarkets: async () => { throw new DexScreenerProviderError("request_timeout"); },
    getTokenAccountPages: async () => { holderCalls += 1; return holderAcquisition(); },
  }));

  assert.deepEqual(result.sections[1].sourceStatus, {
    status: "unavailable", reason: "market_provider_unavailable", errorCategory: "request_timeout",
  });
  assert.equal(result.sections[2].sourceStatus.status, "present");
  assert.equal(holderCalls, 1);
});

test("recognized mint provider failure is presented and prevents dependent acquisitions", async () => {
  let marketCalls = 0;
  let holderCalls = 0;
  const result = await generateSolanaTokenEvidencePresentation(REQUEST, dependencies({
    getAccount: async () => { throw new SolanaAccountProviderError("request_timeout"); },
    getMarkets: async () => { marketCalls += 1; return []; },
    getTokenAccountPages: async () => { holderCalls += 1; return holderAcquisition(); },
  }));

  assert.equal(result.sections[0].sourceStatus.status, "unavailable");
  assert.equal(result.sections[1].sourceStatus.status, "not_attempted");
  assert.equal(result.sections[2].sourceStatus.status, "not_attempted");
  assert.equal(marketCalls, 0);
  assert.equal(holderCalls, 0);
});

test("partial holder acquisition remains present and partial with its coverage visible", async () => {
  const result = await generateSolanaTokenEvidencePresentation(REQUEST, dependencies({
    getTokenAccountPages: async () => holderAcquisition([tokenAccount()], "partial"),
  }));

  const holders = result.sections[2];
  assert.equal(holders.sourceStatus.status, "present");
  assert.equal(holders.completeness, "partial");
  assert.equal(holders.acquisition.completeness, "partial");
  assert.equal(holders.acquisition.stopReason, "request_timeout");
  assert.ok(holders.limitations.length > 0);
});

test("invalid request errors propagate unchanged before acquisition", async () => {
  let calls = 0;
  const deps = dependencies({
    getAccount: async () => { calls += 1; return mintAccount(); },
  });
  const invalidRequests = [
    { ...REQUEST, chain: "ethereum" },
    { ...REQUEST, assetAddress: "not-a-public-key" },
    { ...REQUEST, historicalTransactions: { status: "requested", requestedWindow: { fromUnixSecondsInclusive: 5, toUnixSecondsExclusive: 5 } } },
  ];

  for (const request of invalidRequests) {
    await assert.rejects(generateSolanaTokenEvidencePresentation(request, deps), (error) => {
      assert.ok(error instanceof SolanaTokenEvidenceReportRequestError);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test("unexpected dependency exceptions propagate without a success-shaped presentation", async () => {
  const failure = new Error("synthetic dependency failure");
  await assert.rejects(
    generateSolanaTokenEvidencePresentation(REQUEST, dependencies({ getAccount: async () => { throw failure; } })),
    (error) => error === failure,
  );
});

test("exact values, availability reasons, units, denominators, and limitations are preserved", async () => {
  const result = await generateSolanaTokenEvidencePresentation(REQUEST, dependencies());
  const holders = result.sections[2];
  const supply = field(result.sections[0], "identity.raw_supply");
  const holderBalance = field(holders, "holders.observed_positive_balance_raw");
  const concentration = holders.concentration[0];

  assert.equal(supply.rawValue, "1000000");
  assert.equal(holderBalance.rawValue, "100");
  assert.equal(holderBalance.unit, "raw token units");
  assert.equal(concentration.denominatorBasis, "current_mint_supply");
  assert.equal(concentration.denominatorRaw, "1000000");
  assert.equal(concentration.denominatorDescription, "Current mint supply");
  assert.equal(field(holders, "holders.minimum_balance_raw").status, "available");
  assert.equal(field(holders, "holders.minimum_balance_raw").provenance.provider, "helius");
  assert.ok(result.limitations.some((item) => item.includes("not an atomic")));
  assert.ok(holders.limitations.some((item) => item.includes("unadjusted")));
  assert.equal(Object.hasOwn(result, "score"), false);
});

test("equivalent fixture runs are deterministic and do not mutate caller inputs", async () => {
  const request = structuredClone(REQUEST);
  const fixture = {
    getAccount: async () => mintAccount(),
    getMarkets: async () => [pool()],
    getTokenAccountPages: async () => holderAcquisition(),
    now: () => new Date(FETCHED_AT),
  };
  const originalRequest = structuredClone(request);
  const originalDependencyKeys = Object.keys(fixture);
  const first = await generateSolanaTokenEvidencePresentation(request, fixture);
  const second = await generateSolanaTokenEvidencePresentation(request, fixture);

  assert.deepEqual(first, second);
  assert.deepEqual(request, originalRequest);
  assert.deepEqual(Object.keys(fixture), originalDependencyKeys);
});
