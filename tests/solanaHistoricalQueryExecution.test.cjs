const assert = require("node:assert/strict");
const { test } = require("node:test");
const { executeSolanaHistoricalQueryPlan } = require("../dist/execution/solanaHistoricalQueryExecution.js");
const { getHeliusHistoricalTransferPage } = require("../dist/providers/solana/heliusHistoricalTransferAdapter.js");
const { HeliusTransferProviderError } = require("../dist/providers/solana/heliusTransfersByAddress.js");
const { buildSolanaHistoricalQueryPlan } = require("../dist/normalization/solanaHistoricalQueryPlan.js");
const { selectSolanaHistoricalAuthorities } = require("../dist/normalization/solanaHistoricalAuthoritySelector.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const MINT = key(42);
const SECRET = "test-api-key-do-not-leak";
const CURSOR = "opaque-cursor-do-not-leak";

function holderStructure(balances) {
  const rawOwnerAuthorities = balances.map((balanceRaw, index) => ({
    ownerAddress: key(index + 1),
    balanceRaw: String(balanceRaw),
    tokenAccountCount: 1,
  }));
  return {
    chain: "solana",
    mintAddress: MINT,
    tokenProgram: "spl-token",
    decimals: 6,
    currentMintSupplyRaw: "1000000000",
    observedPositiveBalanceRaw: "100",
    supplyDifferenceRaw: "999999900",
    fetchedAt: "2026-10-01T12:00:00.000Z",
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [100, 101] },
    tokenAccountCount: rawOwnerAuthorities.length,
    nonzeroTokenAccountCount: rawOwnerAuthorities.length,
    tokenAccountStateSummary: {
      initialized: { tokenAccountCount: rawOwnerAuthorities.length, positiveBalanceTokenAccountCount: rawOwnerAuthorities.length, observedBalanceRaw: "100" },
      frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
    },
    rawOwnerCount: rawOwnerAuthorities.length,
    rawOwnerAuthorities,
    amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null },
    concentration: {},
  };
}

function makePlan(balances = [100, 90, 80, 70], selectionCap = 2, overrides = {}) {
  const holder = holderStructure(balances);
  const selection = selectSolanaHistoricalAuthorities(holder, selectionCap);
  return buildSolanaHistoricalQueryPlan({
    holderStructure: holder,
    selection,
    requestedWindow: { fromUnixSecondsInclusive: 1_700_000_000, toUnixSecondsExclusive: 1_700_086_400 },
    maxPagesPerAuthority: 3,
    maxRecordsPerAuthority: 5,
    ...overrides,
  });
}

function integerStringAmount(value) {
  return { rawAmount: value, exactRawAvailable: true, reportedAmount: value, reportedAmountType: "integer_string" };
}

function nonExactAmount(reportedAmount, reportedAmountType, extra = {}) {
  return { rawAmount: null, exactRawAvailable: false, reportedAmount, reportedAmountType, ...extra };
}

function transfer(signature, amount, extra = {}) {
  return {
    signature,
    slot: 451_000_000,
    blockTime: 1_700_000_100,
    type: "transfer",
    fromUserAccount: key(60),
    toUserAccount: key(61),
    fromTokenAccount: key(62),
    toTokenAccount: key(63),
    mint: MINT,
    amount,
    ...extra,
  };
}

const fixedClock = () => 1_800_000_000_000;

test("executes selected authorities sequentially and assembles full-frame evidence", async () => {
  const plan = makePlan();
  const selected = plan.candidateAuthorities
    .filter((candidate) => candidate.plannedDisposition.status === "selected")
    .sort((a, b) => a.plannedDisposition.selectionPosition - b.plannedDisposition.selectionPosition);
  const requests = [];
  const result = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 5_000,
    now: fixedClock,
    fetchPage: async (request) => {
      requests.push(request);
      if (request.ownerAuthority === selected[0].authorityAddress && request.paginationToken === null) {
        return { observations: [transfer("sig-a", integerStringAmount("42"))], paginationToken: CURSOR };
      }
      if (request.ownerAuthority === selected[0].authorityAddress) {
        return { observations: [transfer("sig-b", integerStringAmount("43"))], paginationToken: null };
      }
      return { observations: [transfer("sig-c", integerStringAmount("44"))], paginationToken: null };
    },
  });

  assert.deepEqual(requests.map((request) => request.ownerAuthority), [
    selected[0].authorityAddress,
    selected[0].authorityAddress,
    selected[1].authorityAddress,
  ]);
  assert.equal(result.plan, plan);
  assert.equal(result.evidence.authorities.length, plan.candidateAuthorities.length);
  assert.equal(result.evidence.authorities.filter((authority) => authority.queryStatus === "success").length, 2);
  const firstObservation = result.evidence.authorities
    .find((authority) => authority.authorityAddress === selected[0].authorityAddress).observations[0].providerRecord;
  assert.equal(firstObservation.signature, "sig-a");
  assert.equal(firstObservation.slot, 451_000_000);
  assert.equal(firstObservation.blockTime, 1_700_000_100);
  assert.equal(firstObservation.type, "transfer");
  assert.equal(firstObservation.fromUserAccount, key(60));
  assert.equal(firstObservation.toUserAccount, key(61));
  assert.equal(firstObservation.fromTokenAccount, key(62));
  assert.equal(firstObservation.toTokenAccount, key(63));
  assert.equal(firstObservation.mint, MINT);
  assert.ok(result.evidence.authorities.filter((authority) => authority.queryStatus === "not_queried")
    .every((authority) => authority.reason === "not_selected" && authority.observations.length === 0));
  assert.equal(result.evidence.authorityScope.candidateAuthorityCount, 4);
  assert.equal(result.evidence.provenance.provider, "helius");
  assert.equal(result.evidence.provenance.method, "getTransfersByAddress");
  assert.deepEqual(result.evidence.applicationDerivedEvidence, { status: "not_calculated", metrics: null });
  assert.equal(result.telemetry.selectedAuthorityCount, 2);
  assert.equal(result.telemetry.attemptedAuthorityCount, 2);
  assert.equal(result.telemetry.completedAuthorityCount, 2);
  assert.equal(result.telemetry.failedAuthorityCount, 0);
  assert.equal(result.telemetry.requestCount, 3);
  assert.equal(result.telemetry.pagesReceived, 3);
  assert.equal(result.telemetry.recordsReturned, 3);
  assert.equal(result.telemetry.creditUsage.status, "unknown");
});

test("represents successful empty history as complete success, distinct from unqueried", async () => {
  const plan = makePlan([100, 90], 1);
  const result = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async () => ({ observations: [], paginationToken: null }),
  });
  const queried = result.evidence.authorities.find((authority) => authority.queryStatus === "success");
  const unqueried = result.evidence.authorities.find((authority) => authority.queryStatus === "not_queried");
  assert.equal(queried.paginationStatus, "complete");
  assert.equal(queried.terminalReason, "natural_termination");
  assert.deepEqual(queried.observations, []);
  assert.equal(unqueried.reason, "not_selected");
  assert.equal(result.telemetry.recordsReturned, 0);
});

test("marks page-cap and record-cap results truncated only when continuation remains", async () => {
  const pagePlan = makePlan([100, 90], 1, { maxPagesPerAuthority: 1 });
  const pageResult = await executeSolanaHistoricalQueryPlan(pagePlan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async () => ({ observations: [transfer("page-cap", integerStringAmount("1"))], paginationToken: CURSOR }),
  });
  const pageAuthority = pageResult.evidence.authorities.find((authority) => authority.queryStatus === "success");
  assert.equal(pageAuthority.paginationStatus, "truncated");
  assert.equal(pageAuthority.terminalReason, "page_cap");
  assert.equal(pageResult.telemetry.truncatedAuthorityCount, 1);

  const naturalAtCapPlan = makePlan([100, 90], 1, { maxPagesPerAuthority: 1, maxRecordsPerAuthority: 1 });
  const naturalAtCapResult = await executeSolanaHistoricalQueryPlan(naturalAtCapPlan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async () => ({ observations: [transfer("natural-at-cap", integerStringAmount("1"))], paginationToken: null }),
  });
  const naturalAtCapAuthority = naturalAtCapResult.evidence.authorities.find((authority) => authority.queryStatus === "success");
  assert.equal(naturalAtCapAuthority.paginationStatus, "complete");
  assert.equal(naturalAtCapAuthority.terminalReason, "natural_termination");

  const recordPlan = makePlan([100, 90], 1, { maxPagesPerAuthority: 4, maxRecordsPerAuthority: 2 });
  const recordRequests = [];
  const recordResult = await executeSolanaHistoricalQueryPlan(recordPlan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async (request) => {
      recordRequests.push(request);
      return {
        observations: [transfer("record-cap-1", integerStringAmount("1")), transfer("record-cap-2", integerStringAmount("2"))],
        paginationToken: CURSOR,
      };
    },
  });
  const recordAuthority = recordResult.evidence.authorities.find((authority) => authority.queryStatus === "success");
  assert.equal(recordAuthority.paginationStatus, "truncated");
  assert.equal(recordAuthority.terminalReason, "record_cap");
  assert.equal(recordRequests.length, 1);
  assert.equal(recordRequests[0].limit, 2);
  assert.equal(recordAuthority.observations.length, 2);
});

test("retains successful earlier pages when a later provider request fails", async () => {
  let requestCount = 0;
  const plan = makePlan([100, 90], 1);
  const result = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async () => {
      requestCount += 1;
      if (requestCount === 1) return { observations: [transfer("retained", integerStringAmount("5"))], paginationToken: CURSOR };
      throw new HeliusTransferProviderError("http", "failure body " + SECRET + " https://mainnet.helius-rpc.com/?api-key=" + SECRET);
    },
  });
  const authority = result.evidence.authorities.find((item) => item.queryStatus === "provider_error");
  assert.equal(authority.requestCount, 2);
  assert.equal(authority.pages.length, 1);
  assert.equal(authority.observations.length, 1);
  assert.equal(authority.providerError.category, "http");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(result), /https:\/\/mainnet\.helius-rpc\.com/);
  assert.equal(result.telemetry.failedAuthorityCount, 1);
  assert.deepEqual(result.telemetry.sanitizedErrorCounts, { http: 1 });
});

test("one authority failure does not prevent later selected authorities from succeeding", async () => {
  const plan = makePlan([100, 90, 80], 2);
  const selected = plan.candidateAuthorities
    .filter((candidate) => candidate.plannedDisposition.status === "selected")
    .sort((a, b) => a.plannedDisposition.selectionPosition - b.plannedDisposition.selectionPosition);
  let calls = 0;
  const result = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async (request) => {
      calls += 1;
      if (request.ownerAuthority === selected[0].authorityAddress) {
        throw new HeliusTransferProviderError("transport", "untrusted detail that must be hidden");
      }
      return { observations: [transfer("later-success", integerStringAmount("2"))], paginationToken: null };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.telemetry.failedAuthorityCount, 1);
  assert.equal(result.telemetry.completedAuthorityCount, 1);
  assert.equal(result.evidence.authorities.find((authority) => authority.authorityAddress === selected[0].authorityAddress).queryStatus, "provider_error");
  assert.equal(result.evidence.authorities.find((authority) => authority.authorityAddress === selected[1].authorityAddress).queryStatus, "success");
  assert.doesNotMatch(JSON.stringify(result), /untrusted detail/);
});

test("maps malformed provider pages to provider_error without accepting their records", async () => {
  const plan = makePlan([100, 90], 1);
  const result = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async () => ({ observations: [transfer("bad", integerStringAmount("1"))], paginationToken: "" }),
  });
  const authority = result.evidence.authorities.find((item) => item.queryStatus === "provider_error");
  assert.equal(authority.providerError.category, "malformed_response");
  assert.equal(authority.pages.length, 0);
  assert.equal(authority.observations.length, 0);
});

test("repeated continuation cursors become provider errors and never enter output", async () => {
  let requestCount = 0;
  const plan = makePlan([100, 90], 1);
  const result = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async () => {
      requestCount += 1;
      return {
        observations: [transfer("repeat-" + requestCount, integerStringAmount(String(requestCount)))],
        paginationToken: CURSOR,
      };
    },
  });
  const authority = result.evidence.authorities.find((item) => item.queryStatus === "provider_error");
  assert.equal(authority.providerError.category, "pagination");
  assert.equal(requestCount, 2);
  assert.equal(authority.requestCount, 2);
  assert.equal(authority.pages.length, 1);
  assert.deepEqual(authority.pages.map((page) => page.recordCount), [1]);
  assert.equal(authority.observations.length, 1);
  assert.equal(authority.observations[0].providerRecord.signature, "repeat-1");
  assert.equal(authority.observations[0].providerRecord.amount.rawAmount, "1");
  assert.equal(result.telemetry.requestCount, 2);
  assert.equal(result.telemetry.pagesReceived, 1);
  assert.equal(result.telemetry.recordsReturned, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CURSOR));
});

test("timeout is enforced by the Helius adapter and becomes sanitized provider_error evidence", async () => {
  const previousKey = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "local-test-key";
  try {
    const plan = makePlan([100, 90], 1);
    const result = await executeSolanaHistoricalQueryPlan(plan, {
      requestTimeoutMs: 5,
      now: fixedClock,
      fetchPage: (request, timeoutMs) => getHeliusHistoricalTransferPage(request, timeoutMs, (_url, init) =>
        new Promise((_, reject) => {
          const keepAlive = setTimeout(() => {}, 100);

          init.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(keepAlive);
              reject(init.signal.reason);
            },
            { once: true },
          );
        })),
    });
    const authority = result.evidence.authorities.find((item) => item.queryStatus === "provider_error");
    assert.equal(authority.providerError.category, "transport");
    assert.equal(authority.providerError.message, "Helius transfer-history request timed out.");
    assert.equal(result.telemetry.failedAuthorityCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /local-test-key/);
    assert.doesNotMatch(JSON.stringify(result), /api-key=/);
  } finally {
    if (previousKey === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previousKey;
  }
});

test("preserves exact integer strings and keeps numeric, decimal, missing, and UI-only amounts non-raw", async () => {
  const plan = makePlan([100, 90], 1, { maxRecordsPerAuthority: 8 });
  const amounts = [
    integerStringAmount("18446744073709551615"),
    nonExactAmount("42", "safe_integer_number"),
    nonExactAmount(null, "unsafe_integer_number"),
    nonExactAmount("4.5", "non_integer_number"),
    nonExactAmount("4.25", "non_integer_string"),
    nonExactAmount(null, "null"),
    nonExactAmount(null, "missing", { reportedUiAmount: "4.25", reportedUiAmountType: "string" }),
  ];
  const result = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async () => ({
      observations: amounts.map((amount, index) => transfer("amount-" + index, amount)),
      paginationToken: null,
    }),
  });
  const authority = result.evidence.authorities.find((item) => item.queryStatus === "success");
  const evidenceAmounts = authority.observations.map((observation) => observation.providerRecord.amount);
  assert.equal(evidenceAmounts[0].rawAmount, "18446744073709551615");
  assert.equal(evidenceAmounts[0].exactRawAvailable, true);
  for (const amount of evidenceAmounts.slice(1)) {
    assert.equal(amount.rawAmount, null);
    assert.equal(amount.exactRawAvailable, false);
  }
  assert.equal(evidenceAmounts[6].reportedUiAmount, "4.25");
  assert.equal(evidenceAmounts[6].unavailableReason, "not_reported");
});

test("never exceeds per-authority and total plan bounds", async () => {
  const plan = makePlan([100, 90, 80, 70], 2, { maxPagesPerAuthority: 2, maxRecordsPerAuthority: 3 });
  const requests = [];
  const result = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async (request) => {
      requests.push(request);
      return {
        observations: [transfer("call-" + requests.length, integerStringAmount("1"))],
        paginationToken: "next-" + requests.length,
      };
    },
  });
  assert.equal(requests.length, plan.maximumProviderRequests);
  assert.ok(result.evidence.authorities.every((authority) => authority.requestCount <= plan.maxPagesPerAuthority));
  assert.ok(result.evidence.authorities.reduce((sum, authority) => sum + authority.observations.length, 0) <= plan.maximumReturnedRecords);
  assert.equal(result.telemetry.requestCount, plan.maximumProviderRequests);
  assert.equal(result.telemetry.recordsReturned, result.evidence.authorities.reduce((sum, authority) => sum + authority.observations.length, 0));
});

test("produces deterministic output for identical plans, mock responses, and clock", async () => {
  const plan = makePlan([100, 90, 80], 2);
  const options = {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async () => ({ observations: [transfer("stable", integerStringAmount("7"))], paginationToken: null }),
  };
  const first = await executeSolanaHistoricalQueryPlan(plan, options);
  const second = await executeSolanaHistoricalQueryPlan(plan, options);
  assert.deepEqual(first, second);
});

test("does not mutate the plan or execution inputs", async () => {
  const plan = makePlan([100, 90, 80], 2);
  const before = structuredClone(plan);
  await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: fixedClock,
    fetchPage: async () => ({ observations: [], paginationToken: null }),
  });
  assert.deepEqual(plan, before);
});
