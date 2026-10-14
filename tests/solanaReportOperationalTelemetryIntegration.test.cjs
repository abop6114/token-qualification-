const assert = require("node:assert/strict");
const { test } = require("node:test");
const reportModule = require("../dist/application/solanaTokenEvidenceReport.js");
const {
  generateSolanaTokenEvidenceReport,
  generateSolanaTokenEvidenceReportWithTelemetry,
  SolanaTokenEvidenceReportTelemetryError,
} = reportModule;
const telemetryModule = require("../dist/application/solanaReportOperationalTelemetry.js");
const { SolanaAccountProviderError } = require("../dist/providers/solana/heliusRpc.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { decodeSolanaPublicKey, encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

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
const REQUESTED = { ...REQUEST, historicalTransactions: { status: "requested", requestedWindow: WINDOW } };
const STAGE_IDS = [
  "mint_acquisition", "mint_normalization", "market_acquisition", "market_normalization",
  "holder_acquisition", "holder_normalization", "historical_selection_and_planning",
  "historical_page_acquisition", "historical_metrics_and_transaction_selection",
  "transaction_enrichment", "phase2e_integration",
];

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

function availableAccounts(accounts = [tokenAccount()], completeness = "complete") {
  return {
    status: "available",
    completeness,
    stopReason: completeness === "partial" ? "page_cap" : "provider_terminated",
    configuredMaxPages: 20,
    requestedPageSize: 5000,
    pages: [{ accounts, paginationKey: completeness === "partial" ? "2" : null, contextSlot: 100 }],
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

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function rpcMint() {
  const data = Buffer.from(mintAccount().dataBase64, "base64").toString("base64");
  return { jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: {
    owner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"], data: [data, "base64"],
  } } };
}

function rpcTokenAccounts(accounts = [tokenAccount()], paginationKey = null) {
  return { jsonrpc: "2.0", id: "token-accounts", result: { context: { slot: 101 }, value: {
    accounts: accounts.map((account) => ({ pubkey: account.address, account: {
      owner: account.programOwner, data: [account.dataBase64, "base64"], space: account.reportedSpace,
    } })), paginationKey,
  } } };
}

function rpcTransaction(sig) {
  return { jsonrpc: "2.0", id: "tqe-transaction-probe", result: {
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
    meta: { err: null, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [], postTokenBalances: [], preBalances: [1], postBalances: [1] },
    version: "legacy",
  } };
}

function historicalObservation(sig) {
  return {
    signature: sig,
    slot: 451_369_028,
    blockTime: 1_790_100_000,
    type: "transfer",
    fromUserAccount: key(30),
    toUserAccount: HOLDER,
    mint: MINT,
    amount: {
      rawAmount: "7",
      exactRawAvailable: true,
      reportedAmount: "7",
      reportedAmountType: "integer_string",
    },
  };
}

function emitHistoricalRequestObservation(context) {
  const requestSequence = context.allocateRequestSequence();
  context.observeRequest({
    requestSequence,
    section: "historical_acquisition",
    provider: "helius",
    operation: "getTransfersByAddress",
    requestAttempted: true,
    responseReceived: true,
    outcome: "accepted",
    elapsedMs: 0,
    measurementBasis: "instrumented_fetch_invocation",
    providerUsage: { status: "unknown", reason: "provider_usage_not_observed" },
  });
}

function normalizeExistingHistoricalTimings(report) {
  const copy = structuredClone(report);
  const history = copy.historicalTransactions;
  if (history.status === "present") {
    history.evidence.execution.telemetry.elapsedMs = 0;
    history.evidence.transactionEnrichment.telemetry.elapsedMs = 0;
  }
  return copy;
}

function withHeliusKey(callback) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "synthetic-phase3b-test-key";
  return Promise.resolve().then(callback).finally(() => {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  });
}

function stage(sidecar, stage) {
  return sidecar.operationalTelemetry.stageObservations.find((entry) => entry.stage === stage);
}

test("legacy entry point keeps the evidence-only shape and generates the report once", async () => {
  let accountCalls = 0;
  const deps = dependencies({ getAccount: async () => { accountCalls += 1; return mintAccount(); } });
  const report = await generateSolanaTokenEvidenceReport(REQUEST, deps);
  assert.equal(accountCalls, 1);
  assert.equal(report.mint.status, "present");
  assert.equal("operationalTelemetry" in report, false);
  assert.deepEqual(Object.keys(report).sort(), ["assetAddress", "chain", "generatedAt", "holders", "historicalTransactions", "market", "mint", "schemaVersion"].sort());
});

test("telemetry entry point returns a separate sidecar and executes evidence acquisition once", async () => {
  let accountCalls = 0;
  const report = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, dependencies({
    getAccount: async () => { accountCalls += 1; return mintAccount(); },
  }));
  assert.equal(accountCalls, 1);
  assert.equal(report.report.mint.status, "present");
  assert.equal("operationalTelemetry" in report.report, false);
  assert.equal(report.operationalTelemetry.schemaVersion, "solana-report-operational-telemetry-v1");
  assert.notEqual(report.report, report.operationalTelemetry);
});

test("legacy and telemetry-enabled reports are evidence-equivalent for deterministic dependencies", async () => {
  const deps = dependencies({ getMarkets: async () => [{
    chainId: "solana", poolAddress: key(20), dexId: "test", baseTokenAddress: MINT,
    quoteTokenAddress: key(21), priceUsd: "1", marketCapUsd: null, fdvUsd: null,
    liquidityUsd: "0", volumeUsd: {}, poolCreatedAt: null,
  }] });
  const legacy = await generateSolanaTokenEvidenceReport(REQUEST, deps);
  const telemetered = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, deps);
  assert.deepEqual(telemetered.report, legacy);
  assert.deepEqual(telemetered.report.holders, legacy.holders);
});

test("built-in provider paths emit bounded observations with shared invocation sequence", async () => {
  await withHeliusKey(async () => {
    const sig = signature(7);
    const observedMethods = [];
    const fetchImpl = async (url, init = {}) => {
      const urlText = String(url);
      if (urlText.includes("api.dexscreener.com")) {
        observedMethods.push("tokenPairs");
        return response([]);
      }
      const body = JSON.parse(init.body);
      observedMethods.push(body.method);
      if (body.method === "getAccountInfo") return response(rpcMint());
      if (body.method === "getProgramAccountsV2") return response(rpcTokenAccounts());
      if (body.method === "getTransfersByAddress") return response({ jsonrpc: "2.0", id: "tqe-transfer-history-probe", result: {
        data: [{ signature: sig, slot: 451_369_028, blockTime: 1_790_100_000, type: "transfer",
          fromUserAccount: key(30), toUserAccount: HOLDER, mint: MINT, amount: "7" }],
        paginationToken: null,
      } });
      if (body.method === "getTransaction") return response(rpcTransaction(sig));
      throw new Error("Unexpected offline test request.");
    };
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUESTED, {}, { fetchImpl });
    const events = result.operationalTelemetry.requestObservations;
    assert.deepEqual(observedMethods, ["getAccountInfo", "tokenPairs", "getProgramAccountsV2", "getTransfersByAddress", "getTransaction"]);
    assert.deepEqual(events.map((event) => [event.requestSequence, event.section, event.operation, event.outcome]), [
      [1, "mint", "getAccountInfo", "accepted"],
      [2, "market", "tokenPairs", "accepted"],
      [3, "holders", "getProgramAccountsV2", "accepted"],
      [4, "historical_acquisition", "getTransfersByAddress", "accepted"],
      [5, "transaction_enrichment", "getTransaction", "accepted"],
    ]);
    assert.equal(result.report.historicalTransactions.status, "present");
    assert.equal(result.report.historicalTransactions.evidence.execution.telemetry.requestCount, 1);
    assert.equal(result.report.historicalTransactions.evidence.transactionEnrichment.telemetry.requestCount, 1);
    assert.equal(result.operationalTelemetry.requestObservationCoverage, "complete");
    assert.equal(result.operationalTelemetry.providerUsage.status, "unknown");
    assert.equal(result.operationalTelemetry.monetaryCost.status, "unknown");
    assert.deepEqual(result.operationalTelemetry.stageObservations.map((entry) => entry.stage), STAGE_IDS);
    const serialized = JSON.stringify(result.operationalTelemetry);
    for (const privateValue of [MINT, HOLDER, TOKEN_ACCOUNT, sig, "synthetic-phase3b-test-key", "api-key=", "https://", "paginationToken", "amount"]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  });
});

test("built-in holder pagination records every page and keeps partial acquisition distinct from complete instrumentation", async () => {
  await withHeliusKey(async () => {
    let pageNumber = 0;
    // Make the second page a transport failure; the first page remains accepted.
    const failingFetch = async (url, init = {}) => {
      if (String(url).includes("api.dexscreener.com")) return response([]);
      const body = JSON.parse(init.body);
      if (body.method === "getAccountInfo") return response(rpcMint());
      if (body.method === "getProgramAccountsV2") {
        pageNumber += 1;
        if (pageNumber === 1) return response(rpcTokenAccounts([tokenAccount()], "2"));
        throw new Error("private page transport detail");
      }
      throw new Error("History is not requested in this case.");
    };
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, {}, { fetchImpl: failingFetch });
    assert.equal(pageNumber, 2);
    assert.equal(result.report.holders.evidence.holderStructure.enumeration.completeness, "partial");
    assert.deepEqual(result.operationalTelemetry.requestObservations.filter((event) => event.section === "holders")
      .map((event) => [event.operation, event.outcome, event.responseReceived]), [
        ["getProgramAccountsV2", "accepted", true],
        ["getProgramAccountsV2", "transport_error", false],
      ]);
    const holderStage = stage(result, "holder_acquisition");
    assert.equal(holderStage.acquisitionDisposition, "partial");
    assert.deepEqual(holderStage.requestObservationCoverage, { status: "complete" });
    assert.equal(result.operationalTelemetry.requestObservationCoverage, "complete");
  });
});

test("built-in acquisition failures remain failures while their observed request coverage is complete", async () => {
  await withHeliusKey(async () => {
    const fetchImpl = async (url, init = {}) => {
      if (String(url).includes("api.dexscreener.com")) return response({ provider: "failure" }, 503);
      const body = JSON.parse(init.body);
      if (body.method === "getAccountInfo") return response(rpcMint());
      if (body.method === "getProgramAccountsV2") return response(rpcTokenAccounts());
      throw new Error("Unexpected request.");
    };
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, {}, { fetchImpl });
    assert.equal(result.report.market.status, "unavailable");
    const marketStage = stage(result, "market_acquisition");
    assert.equal(marketStage.outcome, "failed");
    assert.equal(marketStage.acquisitionDisposition, "unavailable");
    assert.deepEqual(marketStage.requestObservationCoverage, { status: "complete" });
    assert.equal(result.operationalTelemetry.requestObservations.find((event) => event.section === "market").outcome, "http_error");
    assert.equal(result.operationalTelemetry.requestObservationCoverage, "complete");
  });
});

test("injected high-level dependencies without observed fetches are dependency-only, never zero-request claims", async () => {
  const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, dependencies());
  assert.equal(result.operationalTelemetry.requestObservations.length, 0);
  assert.equal(result.operationalTelemetry.requestObservationCoverage, "partial");
  for (const stageId of ["mint_acquisition", "market_acquisition", "holder_acquisition"]) {
    assert.deepEqual(stage(result, stageId).requestObservationCoverage, {
      status: "dependency_only", reason: "dependency_not_instrumented",
    });
  }
  assert.equal(result.operationalTelemetry.counts.attemptedRequestCount, 0);
});

test("observer failure downgrades stage coverage without changing evidence success", async () => {
  await withHeliusKey(async () => {
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, {}, {
      fetchImpl: async () => response(rpcMint()),
      observeRequest: () => { throw new Error("private observer failure"); },
    });
    assert.equal(result.report.mint.status, "present");
    assert.equal(result.operationalTelemetry.requestObservations.length, 3);
    assert.equal(result.operationalTelemetry.counts.attemptedRequestCount, 3);
    assert.deepEqual(stage(result, "mint_acquisition").requestObservationCoverage, {
      status: "observation_failed", reason: "observer_failure",
    });
    assert.equal(result.operationalTelemetry.requestObservationCoverage, "partial");
  });
});

test("clock failure preserves evidence and requests with null timing and complete request coverage", async () => {
  await withHeliusKey(async () => {
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, {}, {
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes("api.dexscreener.com")) return response([]);
        const body = JSON.parse(init.body);
        if (body.method === "getAccountInfo") return response(rpcMint());
        if (body.method === "getProgramAccountsV2") return response(rpcTokenAccounts());
        throw new Error("Unexpected offline test request.");
      },
      monotonicNow: () => Number.NaN,
    });
    assert.equal(result.report.mint.status, "present");
    assert.equal(result.operationalTelemetry.requestObservations.length, 3);
    assert.equal(result.operationalTelemetry.requestObservations[0].elapsedMs, null);
    assert.equal(stage(result, "mint_acquisition").elapsedMs, null);
    assert.equal(result.operationalTelemetry.reportElapsedMs, null);
    assert.deepEqual(stage(result, "mint_acquisition").requestObservationCoverage, { status: "complete" });
  });
});

test("preflight failure has no provider event and later stages are explicitly skipped", async () => {
  const previous = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  try {
    let fetchCalls = 0;
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, {}, {
      fetchImpl: async () => { fetchCalls += 1; return response({}); },
    });
    assert.equal(fetchCalls, 0);
    assert.equal(result.operationalTelemetry.requestObservations.length, 0);
    assert.deepEqual(stage(result, "mint_acquisition").requestObservationCoverage, {
      status: "preflight_failed", reason: "provider_preflight_failure",
    });
    assert.equal(stage(result, "market_acquisition").outcome, "skipped");
    assert.equal(stage(result, "historical_page_acquisition").outcome, "not_requested");
    assert.equal(result.operationalTelemetry.requestObservationCoverage, "none");
  } finally {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  }
});

test("unresolved mint emits only its acquisition and no synthetic dependent requests", async () => {
  await withHeliusKey(async () => {
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, {}, {
      fetchImpl: async () => response({ jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: null } }),
    });
    assert.equal(result.report.market.status, "not_attempted");
    assert.deepEqual(result.operationalTelemetry.requestObservations.map((event) => event.operation), ["getAccountInfo"]);
    assert.equal(stage(result, "holder_acquisition").requestObservationCoverage.status, "not_attempted");
    assert.equal(result.operationalTelemetry.requestObservationCoverage, "complete");
  });
});

test("history not requested and history requested but preflight-failed remain distinct", async () => {
  const priorKey = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  try {
    const deps = dependencies();
    const notRequested = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, deps);
    assert.equal(notRequested.report.historicalTransactions.status, "not_requested");
    assert.equal(stage(notRequested, "historical_page_acquisition").outcome, "not_requested");

    const requested = await generateSolanaTokenEvidenceReportWithTelemetry(REQUESTED, deps);
    assert.equal(requested.report.historicalTransactions.status, "present");
    assert.equal(requested.report.historicalTransactions.evidence.execution.evidence.authorities[0].queryStatus, "provider_error");
    assert.equal(stage(requested, "historical_page_acquisition").outcome, "failed");
    assert.deepEqual(stage(requested, "historical_page_acquisition").requestObservationCoverage, {
      status: "preflight_failed", reason: "provider_preflight_failure",
    });
    assert.notEqual(requested.report.historicalTransactions.status, notRequested.report.historicalTransactions.status);
  } finally {
    if (priorKey === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = priorKey;
  }
});

test("injected historical page evidence without observed requests is dependency-only, not a zero-request claim", async () => {
  await withHeliusKey(async () => {
    const sig = signature(9);
    let historyCalls = 0;
    let transactionFetchCalls = 0;
    let contextWasProvided = false;
    const deps = dependencies({
      fetchHistoricalPage: async (_input, _timeoutMs, context) => {
        historyCalls += 1;
        contextWasProvided = context !== undefined;
        return { observations: [historicalObservation(sig)], paginationToken: null };
      },
      fetchTransaction: async (_url, init = {}) => {
        transactionFetchCalls += 1;
        const body = JSON.parse(init.body);
        return response(rpcTransaction(body.params[0]));
      },
    });

    const legacy = await generateSolanaTokenEvidenceReport(REQUESTED, deps);
    historyCalls = 0;
    transactionFetchCalls = 0;
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUESTED, deps);

    assert.equal(contextWasProvided, true);
    assert.equal(historyCalls, 1);
    assert.equal(transactionFetchCalls, 1);
    assert.deepEqual(normalizeExistingHistoricalTimings(result.report), normalizeExistingHistoricalTimings(legacy));
    assert.equal(result.report.historicalTransactions.status, "present");
    assert.equal(result.report.historicalTransactions.evidence.execution.evidence.authorities[0].pages.length, 1);
    assert.deepEqual(stage(result, "historical_page_acquisition").requestObservationCoverage, {
      status: "dependency_only", reason: "dependency_not_instrumented",
    });
    assert.equal(result.operationalTelemetry.requestObservations.some((event) => event.section === "historical_acquisition"), false);
    // No observations means no instrumented count; dependency_only prevents that
    // count from being interpreted as proof of zero underlying dependency requests.
    assert.equal(result.operationalTelemetry.requestObservationCoverage, "partial");
  });
});

test("injected historical dependencies may emit observations, but remain partial without complete instrumentation proof", async () => {
  await withHeliusKey(async () => {
    const sig = signature(10);
    let pageCalls = 0;
    let transactionFetchCalls = 0;
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUESTED, dependencies({
      fetchHistoricalPage: async (_input, _timeoutMs, context) => {
        pageCalls += 1;
        assert.ok(context);
        emitHistoricalRequestObservation(context);
        return { observations: [historicalObservation(sig)], paginationToken: null };
      },
      fetchTransaction: async (_url, init = {}) => {
        transactionFetchCalls += 1;
        const body = JSON.parse(init.body);
        return response(rpcTransaction(body.params[0]));
      },
    }));

    const historicalEvents = result.operationalTelemetry.requestObservations
      .filter((event) => event.section === "historical_acquisition");
    assert.equal(pageCalls, 1);
    assert.equal(transactionFetchCalls, 1);
    assert.equal(historicalEvents.length, 1);
    assert.equal(new Set(historicalEvents.map((event) => event.requestSequence)).size, historicalEvents.length);
    assert.deepEqual(stage(result, "historical_page_acquisition").requestObservationCoverage, {
      status: "partial", reason: "instrumentation_incomplete",
    });
    assert.equal(result.operationalTelemetry.requestObservationCoverage, "partial");
  });
});

test("historical caps and transaction enrichment signature cap remain unchanged", async () => {
  await withHeliusKey(async () => {
    const signatures = Array.from({ length: 6 }, (_, index) => signature(index + 1));
    let historyCalls = 0;
    let transactionCalls = 0;
    const fetchImpl = async (url, init = {}) => {
      if (String(url).includes("api.dexscreener.com")) return response([]);
      const body = JSON.parse(init.body);
      if (body.method === "getAccountInfo") return response(rpcMint());
      if (body.method === "getProgramAccountsV2") return response(rpcTokenAccounts());
      if (body.method === "getTransfersByAddress") {
        historyCalls += 1;
        assert.equal(body.params[1].limit, 100);
        return response({ jsonrpc: "2.0", id: "tqe-transfer-history-probe", result: {
          data: signatures.map((sig) => ({ signature: sig, slot: 451_369_028, blockTime: 1_790_100_000,
            type: "transfer", fromUserAccount: key(30), toUserAccount: HOLDER, mint: MINT, amount: "1" })),
          paginationToken: null,
        } });
      }
      if (body.method === "getTransaction") {
        transactionCalls += 1;
        return response(rpcTransaction(body.params[0]));
      }
      throw new Error("Unexpected request.");
    };
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUESTED, {}, { fetchImpl });
    assert.equal(historyCalls, 1);
    assert.equal(transactionCalls, 5);
    assert.equal(result.report.historicalTransactions.evidence.queryPlan.maxPagesPerAuthority, 2);
    assert.equal(result.report.historicalTransactions.evidence.queryPlan.maxRecordsPerAuthority, 150);
    assert.equal(result.report.historicalTransactions.evidence.transactionEnrichment.telemetry.requestCount, 5);
    assert.equal(result.operationalTelemetry.requestObservations.length, 9);
    assert.equal(new Set(result.operationalTelemetry.requestObservations.map((event) => event.requestSequence)).size, 9);
  });
});

test("telemetry aggregation failure is explicit, sanitized, and retains the completed report", async () => {
  const original = telemetryModule.aggregateSolanaReportOperationalTelemetry;
  telemetryModule.aggregateSolanaReportOperationalTelemetry = () => { throw new Error("private aggregation detail"); };
  try {
    await assert.rejects(generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, dependencies()), (error) => {
      assert.ok(error instanceof SolanaTokenEvidenceReportTelemetryError);
      assert.equal(error.report.mint.status, "present");
      assert.equal(error.message.includes("private aggregation detail"), false);
      assert.equal("cause" in error, false);
      return true;
    });
  } finally {
    telemetryModule.aggregateSolanaReportOperationalTelemetry = original;
  }
});

test("operational sidecar preserves unknown provider usage and excludes evidence identity", async () => {
  const result = await generateSolanaTokenEvidenceReportWithTelemetry(REQUEST, dependencies());
  assert.deepEqual(result.operationalTelemetry.providerUsage, { status: "unknown", reason: "provider_usage_not_observed" });
  assert.deepEqual(result.operationalTelemetry.monetaryCost, { status: "unknown", reason: "monetary_cost_not_verified" });
  assert.equal(JSON.stringify(result.operationalTelemetry).includes(MINT), false);
});
