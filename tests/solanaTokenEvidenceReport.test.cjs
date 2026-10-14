const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  generateSolanaTokenEvidenceReport,
  SolanaTokenEvidenceReportRequestError,
} = require("../dist/application/solanaTokenEvidenceReport.js");
const { generateSolanaTokenEvidencePresentation } = require("../dist/application/solanaTokenEvidencePresentationService.js");
const { SolanaAccountProviderError } = require("../dist/providers/solana/heliusRpc.js");
const { DexScreenerProviderError } = require("../dist/providers/market/dexScreener.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { decodeSolanaPublicKey, encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");
const { SolanaExecutionCancelledError } = require("../dist/types/solanaTrustedExecutionContext.js");

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const signature = (byte) => {
  let value = BigInt(`0x${Buffer.alloc(64, byte).toString("hex")}`);
  let result = "";
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  while (value > 0n) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  return result;
};
const MINT = key(90);
const HOLDER = key(4);
const TOKEN_ACCOUNT = key(5);
const FETCHED_AT = "2026-10-13T15:00:00.000Z";
const WINDOW = { fromUnixSecondsInclusive: 1_790_000_000, toUnixSecondsExclusive: 1_800_000_000 };
const REQUEST = { chain: "solana", assetAddress: MINT, historicalTransactions: { status: "not_requested" } };

function mintAccount(owner = SOLANA_TOKEN_PROGRAM_IDS["spl-token"], supply = 1_000_000n) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(supply, 36);
  data[44] = 6;
  data[45] = 1;
  return { requestedAddress: MINT, owner, dataBase64: data.toString("base64") };
}

function tokenAccount(balance = 100n, tokenProgram = "spl-token", tokenAddress = TOKEN_ACCOUNT, holderAddress = HOLDER) {
  const data = Buffer.alloc(165);
  data.set(Buffer.from(decodeSolanaPublicKey(MINT)), 0);
  data.set(Buffer.from(decodeSolanaPublicKey(holderAddress)), 32);
  data.writeBigUInt64LE(balance, 64);
  data[108] = 1;
  return {
    address: tokenAddress,
    programOwner: SOLANA_TOKEN_PROGRAM_IDS[tokenProgram],
    dataBase64: data.toString("base64"),
    reportedSpace: data.length,
  };
}

function availableAccounts(accounts = [tokenAccount()], completeness = "complete") {
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

function marketPool(overrides = {}) {
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
    getMarkets: async () => [],
    getTokenAccountPages: async () => availableAccounts(),
    now: () => new Date(FETCHED_AT),
    ...overrides,
  };
}

function requestHistory(request = REQUEST) {
  return { ...request, historicalTransactions: { status: "requested", requestedWindow: WINDOW } };
}

function rawTransfer(sig, blockTime = 1_790_100_000) {
  return {
    signature: sig,
    slot: 451_369_028,
    blockTime,
    type: "transfer",
    fromUserAccount: key(30),
    toUserAccount: HOLDER,
    mint: MINT,
    amount: { rawAmount: "7", exactRawAvailable: true, reportedAmount: "7", reportedAmountType: "integer_string" },
  };
}

function transactionResult(sig) {
  return {
    slot: 451_369_028,
    blockTime: 1_790_100_000,
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: [key(40)],
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
        instructions: [],
      },
    },
    meta: {
      err: null,
      innerInstructions: [],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [],
      postTokenBalances: [],
      preBalances: [1],
      postBalances: [1],
    },
    version: "legacy",
  };
}

function rpcResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function withHeliusKey(callback) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "offline-report-test-key";
  return Promise.resolve().then(callback).finally(() => {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  });
}

test("validates chain, address, required request shape, and historical window before any provider call", async () => {
  let calls = 0;
  const deps = dependencies({
    getAccount: async () => { calls += 1; return mintAccount(); },
    getMarkets: async () => { calls += 1; return []; },
    getTokenAccountPages: async () => { calls += 1; return availableAccounts(); },
  });
  const invalid = [
    [{ ...REQUEST, chain: "ethereum" }, "invalid_chain"],
    [{ ...REQUEST, assetAddress: "not-a-public-key" }, "invalid_asset_address"],
    [{ chain: "solana", assetAddress: MINT }, "invalid_request_shape"],
    [{ ...requestHistory(), historicalTransactions: { status: "requested", requestedWindow: { ...WINDOW, toUnixSecondsExclusive: WINDOW.fromUnixSecondsInclusive } } }, "invalid_historical_window"],
    [{ ...REQUEST, requestTimeoutMs: 1 }, "invalid_request_shape"],
  ];
  for (const [input, reason] of invalid) {
    await assert.rejects(generateSolanaTokenEvidenceReport(input, deps), (error) => {
      assert.ok(error instanceof SolanaTokenEvidenceReportRequestError);
      assert.equal(error.reason, reason);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test("confirmed missing account is determinate and leaves dependent sections not attempted", async () => {
  let marketCalls = 0;
  let holderCalls = 0;
  const report = await generateSolanaTokenEvidenceReport(requestHistory(), dependencies({
    getAccount: async () => null,
    getMarkets: async () => { marketCalls += 1; return []; },
    getTokenAccountPages: async () => { holderCalls += 1; return availableAccounts(); },
  }));
  assert.deepEqual(report.mint, { status: "present", evidence: { resolution: { exists: false, isMint: false } } });
  assert.deepEqual(report.market, { status: "not_attempted", reason: "mint_unresolved" });
  assert.deepEqual(report.holders, { status: "not_attempted", reason: "mint_unresolved" });
  assert.deepEqual(report.historicalTransactions, { status: "not_attempted", reason: "mint_unresolved" });
  assert.equal(marketCalls, 0);
  assert.equal(holderCalls, 0);
});

test("existing non-mint account is distinct from a missing account", async () => {
  const report = await generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getAccount: async () => mintAccount(key(88)),
  }));
  assert.deepEqual(report.mint, { status: "present", evidence: { resolution: { exists: true, isMint: false } } });
  assert.equal(report.market.status, "not_attempted");
});

test("resolved classic mint preserves mint facts, empty market evidence, holder metrics, and snapshot provenance", async () => {
  let accountCalls = 0;
  const holderAcquisition = availableAccounts();
  const report = await generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getAccount: async () => { accountCalls += 1; return mintAccount(); },
    getMarkets: async () => [],
    getTokenAccountPages: async () => holderAcquisition,
  }));
  assert.equal(accountCalls, 1);
  assert.equal(report.mint.status, "present");
  assert.equal(report.mint.evidence.resolution.isMint, true);
  assert.equal(report.mint.evidence.resolution.rawSupply, "1000000");
  assert.deepEqual(report.mint.evidence.token2022MintExtensionInventory, {
    schemaVersion: "solana-token-2022-mint-extension-inventory-v1",
    chain: "solana",
    mintAddress: MINT,
    tokenProgram: "spl-token",
    status: "not_applicable",
  });
  assert.equal(report.market.status, "present");
  assert.deepEqual(report.market.evidence.pools, []);
  assert.equal(report.market.evidence.primaryPoolAddress, null);
  assert.equal(report.holders.status, "present");
  assert.equal(report.holders.evidence.holderStructure.rawOwnerCount, 1);
  assert.equal(report.holders.evidence.ownerAuthorityBalanceDistribution.observedPositiveOwnerAuthorityBalanceRaw, "100");
  assert.equal(report.holders.evidence.snapshotRecord.schemaVersion, "solana-holder-snapshot-record-v2");
  assert.deepEqual(report.holders.evidence.snapshotRecord.acquisition, {
    completeness: holderAcquisition.completeness,
    stopReason: holderAcquisition.stopReason,
    configuredMaxPages: holderAcquisition.configuredMaxPages,
    requestedPageSize: holderAcquisition.requestedPageSize,
  });
  assert.equal(JSON.stringify(report).includes("paginationKey"), false);
  assert.deepEqual(report.historicalTransactions, { status: "not_requested" });
});

test("Token-2022 mint retains the existing extension inventory", async () => {
  const data = Buffer.alloc(166);
  data.writeBigUInt64LE(10n, 36);
  data[45] = 1;
  data[165] = 1;
  const account = { requestedAddress: MINT, owner: SOLANA_TOKEN_PROGRAM_IDS["token-2022"], dataBase64: data.toString("base64") };
  const report = await generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getAccount: async () => account,
    getTokenAccountPages: async () => ({ status: "unavailable", reason: "configuration_error", configuredMaxPages: 20, requestedPageSize: 5000, pages: [] }),
  }));
  assert.equal(report.mint.evidence.resolution.tokenProgram, "token-2022");
  assert.deepEqual(report.mint.evidence.token2022MintExtensionInventory.extensions, []);
});

test("market provider failure does not suppress holder evidence", async () => {
  let holderCalls = 0;
  const report = await generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getMarkets: async () => { throw new DexScreenerProviderError("transport_error"); },
    getTokenAccountPages: async () => { holderCalls += 1; return availableAccounts(); },
  }));
  assert.deepEqual(report.market, {
    status: "unavailable", reason: "market_provider_unavailable", errorCategory: "transport_error",
  });
  assert.equal(report.holders.status, "present");
  assert.equal(holderCalls, 1);
});

test("holder acquisition failure does not suppress market evidence", async () => {
  let marketCalls = 0;
  let holderCalls = 0;
  let historicalCalls = 0;
  const report = await generateSolanaTokenEvidenceReport(requestHistory(), dependencies({
    getMarkets: async () => { marketCalls += 1; return [marketPool()]; },
    getTokenAccountPages: async () => {
      holderCalls += 1;
      return { status: "unavailable", reason: "request_timeout", configuredMaxPages: 20, requestedPageSize: 5000, pages: [] };
    },
    fetchHistoricalPage: async () => { historicalCalls += 1; throw new Error("unavailable holders must skip history"); },
  }));
  assert.equal(report.market.status, "present");
  assert.equal(report.market.evidence.pools.length, 1);
  assert.deepEqual(report.holders, {
    status: "unavailable", reason: "holder_acquisition_unavailable", errorCategory: "request_timeout",
  });
  assert.deepEqual(report.historicalTransactions, { status: "not_attempted", reason: "holder_evidence_unavailable" });
  assert.equal(marketCalls, 1);
  assert.equal(holderCalls, 1);
  assert.equal(historicalCalls, 0);
});

test("unexpected holder acquisition exceptions propagate and are not retried or relabeled", async () => {
  const failure = new Error("unexpected acquisition contract defect");
  let marketCalls = 0;
  let holderCalls = 0;
  let historicalCalls = 0;
  await assert.rejects(generateSolanaTokenEvidenceReport(requestHistory(), dependencies({
    getMarkets: async () => { marketCalls += 1; return [marketPool()]; },
    getTokenAccountPages: async () => { holderCalls += 1; throw failure; },
    fetchHistoricalPage: async () => { historicalCalls += 1; throw new Error("must not reach history"); },
  })), (error) => error === failure);
  assert.equal(marketCalls, 1);
  assert.equal(holderCalls, 1);
  assert.equal(historicalCalls, 0);
});

test("partial holder snapshot preserves its actual acquisition stop metadata", async () => {
  const holderAcquisition = availableAccounts([tokenAccount()], "partial");
  const report = await generateSolanaTokenEvidenceReport(requestHistory(), dependencies({
    getTokenAccountPages: async () => holderAcquisition,
    fetchHistoricalPage: async () => ({ observations: [], paginationToken: null }),
  }));
  assert.equal(report.holders.status, "present");
  assert.deepEqual(report.holders.evidence.snapshotRecord.acquisition, {
    completeness: holderAcquisition.completeness,
    stopReason: holderAcquisition.stopReason,
    configuredMaxPages: holderAcquisition.configuredMaxPages,
    requestedPageSize: holderAcquisition.requestedPageSize,
  });
  assert.equal(report.holders.evidence.snapshotRecord.acquisition.stopReason, "request_timeout");
});

test("typed provider failures are sanitized and do not expose provider secrets", async () => {
  const report = await generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getAccount: async () => { throw new SolanaAccountProviderError("transport_error"); },
  }));
  const serialized = JSON.stringify(report);
  assert.equal(report.mint.status, "unavailable");
  assert.equal(report.mint.errorCategory, "transport_error");
  assert.equal(serialized.includes("HELIUS_API_KEY"), false);
  assert.equal(serialized.includes("api-key="), false);
});

test("history not requested performs no historical calls", async () => {
  let historicalCalls = 0;
  const report = await generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    fetchHistoricalPage: async () => { historicalCalls += 1; throw new Error("must not call history"); },
    fetchTransaction: async () => { historicalCalls += 1; throw new Error("must not enrich"); },
  }));
  assert.deepEqual(report.historicalTransactions, { status: "not_requested" });
  assert.equal(historicalCalls, 0);
});

test("partial holder acquisition remains partial and may feed the bounded historical pipeline", async () => {
  let historyCalls = 0;
  const report = await generateSolanaTokenEvidenceReport(requestHistory(), dependencies({
    getTokenAccountPages: async () => availableAccounts([tokenAccount()], "partial"),
    fetchHistoricalPage: async () => { historyCalls += 1; return { observations: [], paginationToken: null }; },
  }));
  assert.equal(report.holders.status, "present");
  assert.equal(report.holders.evidence.holderStructure.enumeration.completeness, "partial");
  assert.equal(report.holders.evidence.snapshotRecord.acquisition.completeness, "partial");
  assert.equal(report.historicalTransactions.status, "present");
  assert.equal(report.historicalTransactions.evidence.authoritySelection.sourceHolder.candidateFrameCompleteness, "partial");
  assert.equal(historyCalls, 1);
});

test("requested history uses fixed bounds and integrates at most five signatures", async () => {
  await withHeliusKey(async () => {
    const signatures = Array.from({ length: 6 }, (_, index) => signature(index + 1));
    let requestedPageLimit;
    let historyCalls = 0;
    let transactionCalls = 0;
    const report = await generateSolanaTokenEvidenceReport(requestHistory(), dependencies({
      fetchHistoricalPage: async (input, timeoutMs) => {
        historyCalls += 1;
        requestedPageLimit = input.limit;
        assert.equal(timeoutMs, 30_000);
        assert.equal(input.ownerAuthority, HOLDER);
        assert.equal(input.toUnixSecondsExclusive, WINDOW.toUnixSecondsExclusive);
        return { observations: signatures.map((sig) => rawTransfer(sig)), paginationToken: null };
      },
      fetchTransaction: async (_url, init) => {
        transactionCalls += 1;
        const body = JSON.parse(init.body);
        const requested = body.params[0];
        return rpcResponse({ jsonrpc: "2.0", id: "tqe-transaction-probe", result: transactionResult(requested) });
      },
    }));
    assert.equal(report.historicalTransactions.status, "present");
    const history = report.historicalTransactions.evidence;
    assert.equal(history.authoritySelection.selectedAuthorityCount, 1);
    assert.equal(history.queryPlan.maxPagesPerAuthority, 2);
    assert.equal(history.queryPlan.maxRecordsPerAuthority, 150);
    assert.equal(history.execution.telemetry.requestCount, 1);
    assert.equal(history.execution.telemetry.recordsReturned, 6);
    assert.equal(history.transactionSelection.signatureCap, 5);
    assert.equal(history.transactionSelection.selectedUniqueSignatureCount, 5);
    assert.equal(history.transactionEnrichment.telemetry.requestCount, 5);
    assert.equal(history.transactionIntegration.phase2A, history.transactionEnrichment);
    assert.equal(historyCalls, 1);
    assert.equal(transactionCalls, 5);
    assert.equal(requestedPageLimit, 100);
    assert.equal(JSON.stringify(history).includes("offline-report-test-key"), false);
  });
});

test("no selected historical authority produces deterministic empty-selection evidence and no calls", async () => {
  let historyCalls = 0;
  const report = await generateSolanaTokenEvidenceReport(requestHistory(), dependencies({
    getTokenAccountPages: async () => availableAccounts([]),
    fetchHistoricalPage: async () => { historyCalls += 1; throw new Error("no authority should be queried"); },
  }));
  assert.equal(report.historicalTransactions.status, "present");
  assert.equal(report.historicalTransactions.evidence.authoritySelection.selectedAuthorityCount, 0);
  assert.equal(report.historicalTransactions.evidence.execution.telemetry.requestCount, 0);
  assert.equal(report.historicalTransactions.evidence.descriptiveMetrics.sampleCoverage.queriedAuthorityCount, 0);
  assert.equal(historyCalls, 0);
});

test("unexpected injected provider/internal exceptions propagate instead of becoming unavailable sections", async () => {
  const accountFailure = new Error("unexpected account adapter defect");
  await assert.rejects(generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getAccount: async () => { throw accountFailure; },
  })), (error) => error === accountFailure);

  const marketFailure = new Error("unexpected market adapter defect");
  await assert.rejects(generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getMarkets: async () => { throw marketFailure; },
  })), (error) => error === marketFailure);
});

test("report assembly preserves nested evidence and does not claim atomic observations", async () => {
  const report = await generateSolanaTokenEvidenceReport(REQUEST, dependencies({ getMarkets: async () => [marketPool()] }));
  assert.equal(report.schemaVersion, "solana-token-evidence-report-v1");
  assert.equal(report.generatedAt, FETCHED_AT);
  assert.equal(report.holders.evidence.snapshotRecord.snapshot.fetchedAt, FETCHED_AT);
  assert.equal(report.market.evidence.provenance.fetchedAt, FETCHED_AT);
  assert.equal(report.holders.evidence.snapshotRecord.snapshot.enumeration.slotConsistency, "not_guaranteed");
  assert.equal(report.chain, "solana");
});

test("trusted caller cancellation stops report acquisition without becoming evidence", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let calls = 0;
  await assert.rejects(generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getAccount: async () => { calls += 1; return mintAccount(); },
  }), { signal: preAborted.signal }), SolanaExecutionCancelledError);
  assert.equal(calls, 0);

  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const operation = generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getAccount: async (_address, signal) => {
      assert.equal(signal, controller.signal);
      markStarted();
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new SolanaExecutionCancelledError(true)), { once: true }));
    },
  }), { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(operation, SolanaExecutionCancelledError);
});

test("cancellation at report completion prevents report success and presentation conversion", async () => {
  const controller = new AbortController();
  const now = () => { controller.abort(); return new Date(FETCHED_AT); };
  await assert.rejects(generateSolanaTokenEvidenceReport(REQUEST, dependencies({
    getAccount: async () => null,
    now,
  }), { signal: controller.signal }), SolanaExecutionCancelledError);

  const presentationController = new AbortController();
  await assert.rejects(generateSolanaTokenEvidencePresentation(REQUEST, dependencies({
    getAccount: async () => null,
    now: () => { queueMicrotask(() => presentationController.abort()); return new Date(FETCHED_AT); },
  }), { signal: presentationController.signal }), SolanaExecutionCancelledError);
});
