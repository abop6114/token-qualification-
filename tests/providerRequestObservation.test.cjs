const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getSolanaAccount, SolanaAccountProviderError } = require("../dist/providers/solana/heliusRpc.js");
const { getSolanaMintMarkets, DexScreenerProviderError } = require("../dist/providers/market/dexScreener.js");
const { getSolanaTokenAccountPages } = require("../dist/providers/solana/heliusTokenAccounts.js");
const { getHeliusHistoricalTransferPage } = require("../dist/providers/solana/heliusHistoricalTransferAdapter.js");
const { HeliusTransferProviderError } = require("../dist/providers/solana/heliusTransfersByAddress.js");
const { getHeliusTransaction, HeliusTransactionProviderError } = require("../dist/providers/solana/heliusTransaction.js");
const { buildSolanaHistoricalQueryPlan } = require("../dist/normalization/solanaHistoricalQueryPlan.js");
const { selectSolanaHistoricalAuthorities } = require("../dist/normalization/solanaHistoricalAuthoritySelector.js");
const { executeSolanaHistoricalQueryPlan } = require("../dist/execution/solanaHistoricalQueryExecution.js");
const { createSolanaHistoricalTransactionSelection } = require("../dist/normalization/solanaHistoricalTransactionSelector.js");
const { executeSolanaTransactionEnrichment } = require("../dist/execution/solanaTransactionEnrichment.js");
const { aggregateSolanaReportOperationalTelemetry } = require("../dist/application/solanaReportOperationalTelemetry.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const FAKE_KEY = "synthetic-test-key-not-a-credential";
const ADDRESS = "11111111111111111111111111111111";
const MINT = encodeSolanaPublicKey(Buffer.alloc(32, 42));
const OWNER = encodeSolanaPublicKey(Buffer.alloc(32, 8));
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SIG_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function signature(byte) {
  let value = BigInt(`0x${Buffer.alloc(64, byte).toString("hex")}`);
  let result = "";
  while (value > 0n) { result = SIG_ALPHABET[Number(value % 58n)] + result; value /= 58n; }
  return result;
}

function observationContext(options = {}) {
  let next = 0;
  let clock = 10;
  const events = [];
  const limitations = [];
  const context = {
    allocateRequestSequence: options.allocateRequestSequence ?? (() => ++next),
    observeRequest: options.observeRequest ?? ((event) => { events.push(event); }),
    onObservationLimitation: (reason) => limitations.push(reason),
    monotonicNow: options.monotonicNow ?? (() => { clock += 2; return clock; }),
  };
  return { context, events, limitations };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function rpcAccount(value = null) {
  return { jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value } };
}

function withApiKey(callback) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = FAKE_KEY;
  return Promise.resolve().then(callback).finally(() => {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  });
}

function assertEvent(event, expected) {
  assert.deepEqual({
    requestSequence: event.requestSequence,
    section: event.section,
    provider: event.provider,
    operation: event.operation,
    requestAttempted: event.requestAttempted,
    responseReceived: event.responseReceived,
    outcome: event.outcome,
    measurementBasis: event.measurementBasis,
    providerUsage: event.providerUsage,
  }, expected);
  assert.equal(event.elapsedMs === null || (Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0), true);
}

test("existing callers without observation context preserve provider results", async () => {
  await withApiKey(async () => {
    const result = await getSolanaAccount(ADDRESS, async () => response(rpcAccount(null)), 500);
    assert.equal(result, null);
    const market = await getSolanaMintMarkets(MINT, async () => response([]), 500);
    assert.deepEqual(market, []);
  });
});

test("one accepted getAccountInfo fetch emits one sanitized mint observation", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    const owner = TOKEN_PROGRAM;
    const dataBase64 = Buffer.from("synthetic-account-data").toString("base64");
    let calls = 0;
    const result = await getSolanaAccount(ADDRESS, async (_url, init) => {
      calls += 1;
      assert.equal(init.method, "POST");
      return response(rpcAccount({ owner, data: [dataBase64, "base64"] }));
    }, 500, recorder.context);
    assert.equal(result.dataBase64, dataBase64);
    assert.equal(calls, 1);
    assert.equal(recorder.events.length, 1);
    assertEvent(recorder.events[0], {
      requestSequence: 1, section: "mint", provider: "helius", operation: "getAccountInfo",
      requestAttempted: true, responseReceived: true, outcome: "accepted",
      measurementBasis: "instrumented_fetch_invocation",
      providerUsage: { status: "unknown", reason: "provider_usage_not_observed" },
    });
  });
});

test("accepted market request and token-account pages emit one event per fetch", async () => {
  await withApiKey(async () => {
    const marketRecorder = observationContext();
    assert.deepEqual(await getSolanaMintMarkets(MINT, async () => response([]), 500, marketRecorder.context), []);
    assert.equal(marketRecorder.events.length, 1);
    assert.equal(marketRecorder.events[0].operation, "tokenPairs");
    assert.equal(marketRecorder.events[0].section, "market");
    assert.equal(marketRecorder.events[0].provider, "dexscreener");

    const pageRecorder = observationContext();
    let pageCall = 0;
    const pages = await getSolanaTokenAccountPages(MINT, "spl-token", async (_url, init) => {
      pageCall += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.method, "getProgramAccountsV2");
      return response({ jsonrpc: "2.0", id: "token-accounts", result: {
        context: { slot: 100 }, value: { accounts: [], paginationKey: pageCall === 1 ? "2" : null },
      } });
    }, 500, pageRecorder.context);
    assert.equal(pages.status, "available");
    assert.equal(pages.completeness, "complete");
    assert.equal(pageCall, 2);
    assert.deepEqual(pageRecorder.events.map((event) => event.operation), ["getProgramAccountsV2", "getProgramAccountsV2"]);
    assert.deepEqual(pageRecorder.events.map((event) => event.requestSequence), [1, 2]);
  });
});

test("partial token-account acquisition retains accepted page telemetry and the later failure", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    let calls = 0;
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => {
      calls += 1;
      if (calls === 2) throw new Error("private second-page transport detail");
      return response({ jsonrpc: "2.0", id: "token-accounts", result: {
        context: { slot: 100 }, value: { accounts: [], paginationKey: "2" },
      } });
    }, 500, recorder.context);

    assert.equal(result.status, "available");
    assert.equal(result.completeness, "partial");
    assert.equal(result.stopReason, "provider_error");
    assert.equal(result.pages.length, 1);
    assert.equal(calls, 2);
    assert.deepEqual(recorder.events.map((event) => [event.requestSequence, event.outcome, event.responseReceived]), [
      [1, "accepted", true],
      [2, "transport_error", false],
    ]);
    assert.equal(JSON.stringify(recorder.events).includes("private second-page transport detail"), false);
  });
});

test("HTTP, RPC, malformed, and transport outcomes reflect response receipt", async () => {
  await withApiKey(async () => {
    const scenarios = [
      { fetch: async () => response({}, 503), expected: "http_error", received: true, error: SolanaAccountProviderError },
      { fetch: async () => response({ jsonrpc: "2.0", id: 1, error: { code: -1 } }), expected: "rpc_error", received: true, error: SolanaAccountProviderError },
      { fetch: async () => new Response("not-json", { status: 200 }), expected: "malformed_response", received: true, error: SolanaAccountProviderError },
      { fetch: async () => { throw new Error("private transport error"); }, expected: "transport_error", received: false, error: SolanaAccountProviderError },
    ];
    for (const scenario of scenarios) {
      const recorder = observationContext();
      await assert.rejects(getSolanaAccount(ADDRESS, scenario.fetch, 500, recorder.context), scenario.error);
      assert.equal(recorder.events.length, 1);
      assert.equal(recorder.events[0].outcome, scenario.expected);
      assert.equal(recorder.events[0].responseReceived, scenario.received);
    }
  });
});

test("preflight failures produce no events and do not invoke fetch", async () => {
  const previous = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  try {
    const recorder = observationContext();
    let calls = 0;
    await assert.rejects(getSolanaAccount(ADDRESS, async () => { calls += 1; }, 500, recorder.context), SolanaAccountProviderError);
    assert.equal(calls, 0);
    assert.equal(recorder.events.length, 0);
  } finally {
    if (previous !== undefined) process.env.HELIUS_API_KEY = previous;
  }
  const marketRecorder = observationContext();
  let marketCalls = 0;
  await assert.rejects(getSolanaMintMarkets(MINT, async () => { marketCalls += 1; return response([]); }, 0, marketRecorder.context), DexScreenerProviderError);
  assert.equal(marketCalls, 0);
  assert.equal(marketRecorder.events.length, 0);

  const tokenAccountRecorder = observationContext();
  let tokenAccountCalls = 0;
  const tokenAccounts = await getSolanaTokenAccountPages(MINT, "spl-token", async () => {
    tokenAccountCalls += 1;
    return response({});
  }, 500, tokenAccountRecorder.context);
  assert.equal(tokenAccounts.status, "unavailable");
  assert.equal(tokenAccounts.reason, "configuration_error");
  assert.equal(tokenAccountCalls, 0);
  assert.equal(tokenAccountRecorder.events.length, 0);

  const transferRecorder = observationContext();
  let transferCalls = 0;
  await assert.rejects(getHeliusHistoricalTransferPage({
    mintAddress: MINT, ownerAuthority: OWNER, fromUnixSeconds: 1_790_000_000,
    toUnixSecondsExclusive: 1_800_000_000, limit: 10, paginationToken: null,
  }, 0, async () => { transferCalls += 1; return response({}); }, transferRecorder.context));
  assert.equal(transferCalls, 0);
  assert.equal(transferRecorder.events.length, 0);

  const transactionRecorder = observationContext();
  let transactionCalls = 0;
  await assert.rejects(getHeliusTransaction(signature(20), async () => {
    transactionCalls += 1;
    return response({});
  }, 0, transactionRecorder.context), (error) => error.category === "configuration");
  assert.equal(transactionCalls, 0);
  assert.equal(transactionRecorder.events.length, 0);
});

test("adapter-owned timeouts are classified only from the adapter timeout state", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    let calls = 0;
    await assert.rejects(getSolanaAccount(ADDRESS, (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
    }, 5, recorder.context), (error) => error.category === "request_timeout");
    assert.equal(calls, 1);
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].outcome, "request_timeout");
    assert.equal(recorder.events[0].responseReceived, false);

    const afterResponse = observationContext();
    await assert.rejects(getSolanaAccount(ADDRESS, (_url, init) => Promise.resolve({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true })),
    }), 5, afterResponse.context), (error) => error.category === "request_timeout");
    assert.equal(afterResponse.events[0].outcome, "request_timeout");
    assert.equal(afterResponse.events[0].responseReceived, true);
  });
});

test("a standalone AbortError is transport failure even if caller cancellation overlaps before classification", async () => {
  await withApiKey(async () => {
    const controller = new AbortController();
    const recorder = observationContext();
    let rejectFetch;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const pendingFetch = new Promise((_resolve, reject) => { rejectFetch = reject; });
    const operation = getSolanaAccount(ADDRESS, () => { markStarted(); return pendingFetch; }, 5_000, recorder.context, controller.signal);
    await started;
    rejectFetch(new DOMException("independent abort", "AbortError"));
    controller.abort();
    await assert.rejects(operation, (error) => error instanceof SolanaAccountProviderError && error.category === "transport_error");
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].outcome, "transport_error");
  });
});

test("an abort-ignoring fetch is not represented as guaranteed cancelled", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    let signal;
    const resultPromise = getSolanaAccount(ADDRESS, async (_url, init) => {
      signal = init.signal;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return response(rpcAccount(null));
    }, 3, recorder.context);
    await assert.rejects(resultPromise, (error) => error.category === "request_timeout");
    assert.equal(signal.aborted, true);
    assert.equal(recorder.events[0].outcome, "request_timeout");
    assert.equal(recorder.events[0].responseReceived, true);
  });
});

test("historical transfer page emits exactly one lower-boundary event including wrapper timeout attribution", async () => {
  await withApiKey(async () => {
    const input = {
      mintAddress: MINT, ownerAuthority: OWNER, fromUnixSeconds: 1_790_000_000,
      toUnixSecondsExclusive: 1_800_000_000, limit: 10, paginationToken: null,
    };
    const recorder = observationContext();
    let calls = 0;
    const page = await getHeliusHistoricalTransferPage(input, 500, async (_url, init) => {
      calls += 1;
      return response({ jsonrpc: "2.0", id: "tqe-transfer-history-probe", result: { data: [], paginationToken: null } });
    }, recorder.context);
    assert.deepEqual(page, { observations: [], paginationToken: null });
    assert.equal(calls, 1);
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].operation, "getTransfersByAddress");

    const timeoutRecorder = observationContext();
    await assert.rejects(getHeliusHistoricalTransferPage(input, 5, (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true });
    }), timeoutRecorder.context), HeliusTransferProviderError);
    assert.equal(timeoutRecorder.events.length, 1);
    assert.equal(timeoutRecorder.events[0].outcome, "request_timeout");
    assert.equal(timeoutRecorder.events[0].responseReceived, false);
  });
});

function makePlan() {
  const holder = {
    chain: "solana", mintAddress: MINT, tokenProgram: "spl-token", decimals: 6,
    currentMintSupplyRaw: "1000", observedPositiveBalanceRaw: "100", supplyDifferenceRaw: "900",
    fetchedAt: "2026-10-06T11:00:00.000Z",
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 1, contextSlots: [100] },
    tokenAccountCount: 1, nonzeroTokenAccountCount: 1,
    tokenAccountStateSummary: {
      initialized: { tokenAccountCount: 1, positiveBalanceTokenAccountCount: 1, observedBalanceRaw: "100" },
      frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
    },
    rawOwnerCount: 1, rawOwnerAuthorities: [{ ownerAddress: OWNER, balanceRaw: "100", tokenAccountCount: 1 }],
    amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null }, concentration: {},
  };
  const selection = selectSolanaHistoricalAuthorities(holder, 1);
  return buildSolanaHistoricalQueryPlan({
    holderStructure: holder, selection,
    requestedWindow: { fromUnixSecondsInclusive: 1_790_000_000, toUnixSecondsExclusive: 1_800_000_000 },
    maxPagesPerAuthority: 1, maxRecordsPerAuthority: 10,
  });
}

test("historical execution passes one observation through its adapter without wrapper double counting", async () => {
  await withApiKey(async () => {
    const plan = makePlan();
    const recorder = observationContext();
    let calls = 0;
    const history = await executeSolanaHistoricalQueryPlan(plan, {
      requestTimeoutMs: 500,
      requestObservationContext: recorder.context,
      fetchPage: (input, timeout, context) => getHeliusHistoricalTransferPage(input, timeout, async (_url, init) => {
        calls += 1;
        return response({ jsonrpc: "2.0", id: "tqe-transfer-history-probe", result: {
          data: [{ signature: signature(17), slot: 451_369_028, blockTime: 1_790_611_915, type: "transfer", amount: "1" }],
          paginationToken: null,
        } });
      }, context),
    });
    assert.equal(history.telemetry.requestCount, 1);
    assert.equal(calls, 1);
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].operation, "getTransfersByAddress");
    const selection = createSolanaHistoricalTransactionSelection(plan, history.evidence);
    const transaction = await executeSolanaTransactionEnrichment(selection, plan, history.evidence, {
      timeoutMs: 500,
      requestObservationContext: recorder.context,
      fetchImpl: async () => {
        calls += 1;
        return response({ jsonrpc: "2.0", id: "tqe-transaction-probe", result: null });
      },
    });
    assert.equal(transaction.telemetry.requestCount, 1);
    assert.equal(calls, 2);
    assert.equal(recorder.events.length, 2);
    assert.deepEqual(recorder.events.map((event) => [event.requestSequence, event.operation]), [
      [1, "getTransfersByAddress"], [2, "getTransaction"],
    ]);
  });
});

test("transaction provider records one fetch and leaves candidate identity out of telemetry", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    let calls = 0;
    const result = await getHeliusTransaction(signature(18), async () => {
      calls += 1;
      return response({ jsonrpc: "2.0", id: "tqe-transaction-probe", result: null });
    }, 500, recorder.context);
    assert.deepEqual(result, { status: "provider_result_null" });
    assert.equal(calls, 1);
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].operation, "getTransaction");
    assert.equal(recorder.events[0].outcome, "accepted");
  });
});

test("transaction telemetry does not treat an injected timeout-shaped fetch error as its own timeout", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    let calls = 0;
    await assert.rejects(getHeliusTransaction(signature(19), async () => {
      calls += 1;
      throw new HeliusTransactionProviderError("request_timeout", "Synthetic injected error.");
    }, 500, recorder.context), (error) => error.category === "transport");
    assert.equal(calls, 1);
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].outcome, "transport_error");
    assert.equal(recorder.events[0].responseReceived, false);
  });
});

test("pre-aborted historical transfer requests do not invoke fetch or emit an attempt", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(getHeliusHistoricalTransferPage({
      mintAddress: MINT, ownerAuthority: OWNER, fromUnixSeconds: 1_790_000_000,
      toUnixSecondsExclusive: 1_800_000_000, limit: 10, paginationToken: null,
    }, 500, async () => { calls += 1; return response({}); }, recorder.context, controller.signal),
    (error) => error.name === "SolanaExecutionCancelledError" && error.requestAttempted === false);
    assert.equal(calls, 0);
    assert.deepEqual(recorder.events, []);
  });
});

test("active historical transfer cancellation is observed once and stays distinct from transport failure", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    const controller = new AbortController();
    let calls = 0;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const operation = getHeliusHistoricalTransferPage({
      mintAddress: MINT, ownerAuthority: OWNER, fromUnixSeconds: 1_790_000_000,
      toUnixSecondsExclusive: 1_800_000_000, limit: 10, paginationToken: null,
    }, 5_000, async (_url, init) => {
      calls += 1;
      assert.ok(init.signal instanceof AbortSignal);
      markStarted();
      return await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    }, recorder.context, controller.signal);
    await started;
    controller.abort();
    await assert.rejects(operation, (error) => error.name === "SolanaExecutionCancelledError" && error.requestAttempted === true);
    assert.equal(calls, 1);
    assert.equal(recorder.events.length, 1);
    assert.deepEqual([recorder.events[0].outcome, recorder.events[0].requestAttempted, recorder.events[0].responseReceived], ["request_cancelled", true, false]);
  });
});

test("ordinary historical transport failure remains transport_error", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    await assert.rejects(getHeliusHistoricalTransferPage({
      mintAddress: MINT, ownerAuthority: OWNER, fromUnixSeconds: 1_790_000_000,
      toUnixSecondsExclusive: 1_800_000_000, limit: 10, paginationToken: null,
    }, 500, async () => { throw new Error("sanitized transport failure"); }, recorder.context));
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].outcome, "transport_error");
    assert.equal(recorder.events[0].responseReceived, false);
  });
});

test("caller cancellation after a completed historical fetch does not reclassify its observation", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    const controller = new AbortController();
    const page = await getHeliusHistoricalTransferPage({
      mintAddress: MINT, ownerAuthority: OWNER, fromUnixSeconds: 1_790_000_000,
      toUnixSecondsExclusive: 1_800_000_000, limit: 10, paginationToken: null,
    }, 500, async () => response({ jsonrpc: "2.0", id: "tqe-transfer-history-probe", result: { data: [], paginationToken: null } }), recorder.context, controller.signal);
    controller.abort();
    assert.deepEqual(page, { observations: [], paginationToken: null });
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].outcome, "accepted");
  });
});

test("caller cancellation reaches active fetches in the other provider acquisition categories", async () => {
  await withApiKey(async () => {
    const scenarios = [
      { operation: "getAccountInfo", run: (fetch, context, signal) => getSolanaAccount(ADDRESS, fetch, 5_000, context, signal) },
      { operation: "tokenPairs", run: (fetch, context, signal) => getSolanaMintMarkets(MINT, fetch, 5_000, context, signal) },
      { operation: "getProgramAccountsV2", run: (fetch, context, signal) => getSolanaTokenAccountPages(MINT, "spl-token", fetch, 5_000, context, signal) },
      { operation: "getTransaction", run: (fetch, context, signal) => getHeliusTransaction(signature(21), fetch, 5_000, context, signal) },
    ];
    for (const scenario of scenarios) {
      const recorder = observationContext();
      const controller = new AbortController();
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      let calls = 0;
      const operation = scenario.run(async (_url, init) => {
        calls += 1;
        assert.equal(init.signal instanceof AbortSignal, true);
        markStarted();
        return await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      }, recorder.context, controller.signal);
      await started;
      controller.abort();
      await assert.rejects(operation, (error) => error.name === "SolanaExecutionCancelledError" && error.requestAttempted === true);
      assert.equal(calls, 1);
      assert.equal(recorder.events.length, 1);
      assert.deepEqual([recorder.events[0].operation, recorder.events[0].outcome, recorder.events[0].requestAttempted], [scenario.operation, "request_cancelled", true]);
    }
  });
});

test("sequence allocation follows fetch invocation order even when responses finish out of order", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    let calls = 0;
    await Promise.all([
      getSolanaAccount(ADDRESS, async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return response(rpcAccount(null));
      }, 500, recorder.context),
      getSolanaAccount(ADDRESS, async () => {
        calls += 1;
        return response(rpcAccount(null));
      }, 500, recorder.context),
    ]);
    assert.equal(calls, 2);
    assert.deepEqual(recorder.events.map((event) => event.requestSequence), [2, 1]);
    const aggregate = aggregateSolanaReportOperationalTelemetry({
      requestObservations: recorder.events,
      stageObservations: [
        { stage: "mint_acquisition", section: "mint", outcome: "completed", reasonCode: null, elapsedMs: null,
          acquisitionDisposition: "complete", requestObservationCoverage: { status: "complete" } },
      ],
      reportElapsedMs: null,
    });
    assert.deepEqual(aggregate.requestObservations.map((event) => event.requestSequence), [1, 2]);
  });
});

test("observer exceptions never replace success or the original sanitized provider error", async () => {
  await withApiKey(async () => {
    const successful = observationContext({ observeRequest: () => { throw new Error("sentinel-observer-secret"); } });
    assert.equal(await getSolanaAccount(ADDRESS, async () => response(rpcAccount(null)), 500, successful.context), null);
    assert.equal(successful.limitations.includes("observer_delivery_failed"), true);

    const failed = observationContext({ observeRequest: () => { throw new Error("sentinel-observer-secret"); } });
    const resultError = await getSolanaAccount(ADDRESS, async () => { throw new Error("private transport detail"); }, 500, failed.context)
      .then(() => null, (error) => error);
    assert.ok(resultError instanceof SolanaAccountProviderError);
    assert.equal(resultError.category, "transport_error");
    assert.equal(resultError.message.includes("sentinel-observer-secret"), false);
    assert.equal(failed.limitations.includes("observer_delivery_failed"), true);
  });
});

test("sequence allocation failure preserves acquisition and reports the missing observation", async () => {
  await withApiKey(async () => {
    const recorder = observationContext({ allocateRequestSequence: () => { throw new Error("secret sequence failure"); } });
    let calls = 0;
    assert.equal(await getSolanaAccount(ADDRESS, async () => { calls += 1; return response(rpcAccount(null)); }, 500, recorder.context), null);
    assert.equal(calls, 1);
    assert.equal(recorder.events.length, 0);
    assert.equal(recorder.limitations.includes("sequence_allocation_failed"), true);
  });
});

test("invalid monotonic clock values preserve the request with null elapsed time", async () => {
  await withApiKey(async () => {
    let call = 0;
    const recorder = observationContext({ monotonicNow: () => (++call === 1 ? Number.NaN : 100) });
    assert.equal(await getSolanaAccount(ADDRESS, async () => response(rpcAccount(null)), 500, recorder.context), null);
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].elapsedMs, null);
    assert.equal(recorder.limitations.includes("timing_unavailable"), true);
  });
});

test("provider observations contain no sensitive request or error fields", async () => {
  await withApiKey(async () => {
    const recorder = observationContext();
    await getSolanaAccount(ADDRESS, async () => response(rpcAccount(null)), 500, recorder.context);
    const serialized = JSON.stringify(recorder.events);
    for (const privateValue of [ADDRESS, MINT, OWNER, FAKE_KEY, "api-key=", "signature", "https://", "requestBody", "private transport detail"]) {
      assert.equal(serialized.includes(privateValue), false);
    }
    assert.deepEqual(Object.keys(recorder.events[0]).sort(), [
      "elapsedMs", "measurementBasis", "operation", "outcome", "provider", "providerUsage",
      "requestAttempted", "requestSequence", "responseReceived", "section",
    ].sort());
  });
});
