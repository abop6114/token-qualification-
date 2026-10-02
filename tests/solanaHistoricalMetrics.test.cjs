const assert = require("node:assert/strict");
const { test } = require("node:test");
const { calculateSolanaHistoricalDescriptiveMetrics } = require("../dist/normalization/solanaHistoricalMetrics.js");
const { executeSolanaHistoricalQueryPlan } = require("../dist/execution/solanaHistoricalQueryExecution.js");
const { HeliusTransferProviderError } = require("../dist/providers/solana/heliusTransfersByAddress.js");
const { buildSolanaHistoricalQueryPlan } = require("../dist/normalization/solanaHistoricalQueryPlan.js");
const { selectSolanaHistoricalAuthorities } = require("../dist/normalization/solanaHistoricalAuthoritySelector.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const MINT = key(42);
const CURSOR = "metric-cursor";
const NOW = () => 1_800_000_000_000;

function makePlan(balances = [100, 90], selectedCount = 2, overrides = {}) {
  const rawOwnerAuthorities = balances.map((balanceRaw, index) => ({
    ownerAddress: key(index + 1),
    balanceRaw: String(balanceRaw),
    tokenAccountCount: 1,
  }));
  const holderStructure = {
    chain: "solana",
    mintAddress: MINT,
    tokenProgram: "spl-token",
    decimals: 6,
    currentMintSupplyRaw: "1000000",
    observedPositiveBalanceRaw: String(balances.reduce((sum, value) => sum + value, 0)),
    supplyDifferenceRaw: "0",
    fetchedAt: "2026-10-01T12:00:00.000Z",
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 1, contextSlots: [100] },
    tokenAccountCount: balances.length,
    nonzeroTokenAccountCount: balances.length,
    tokenAccountStateSummary: {
      initialized: { tokenAccountCount: balances.length, positiveBalanceTokenAccountCount: balances.length, observedBalanceRaw: "0" },
      frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
    },
    rawOwnerCount: balances.length,
    rawOwnerAuthorities,
    amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null },
    concentration: {},
  };
  const selection = selectSolanaHistoricalAuthorities(holderStructure, selectedCount);
  return buildSolanaHistoricalQueryPlan({
    holderStructure,
    selection,
    requestedWindow: { fromUnixSecondsInclusive: 100, toUnixSecondsExclusive: 200 },
    maxPagesPerAuthority: 3,
    maxRecordsPerAuthority: 20,
    ...overrides,
  });
}

function transfer(signature, overrides = {}) {
  return {
    signature,
    slot: 451_000_000,
    blockTime: 150,
    type: "transfer",
    fromUserAccount: key(50),
    toUserAccount: key(51),
    fromTokenAccount: key(52),
    toTokenAccount: key(53),
    mint: MINT,
    amount: {
      rawAmount: "12",
      exactRawAvailable: true,
      reportedAmount: "12",
      reportedAmountType: "integer_string",
    },
    ...overrides,
  };
}

async function run(plan, fetchPage) {
  const execution = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: NOW,
    fetchPage,
  });
  return {
    execution,
    metrics: calculateSolanaHistoricalDescriptiveMetrics(plan, execution.evidence),
  };
}

test("calculates descriptive metrics independent of record order and preserves duplicate observations", async () => {
  const plan = makePlan([100], 1, { maxRecordsPerAuthority: 10 });
  const authority = plan.candidateAuthorities.find((candidate) => candidate.plannedDisposition.status === "selected").authorityAddress;
  const observations = [
    transfer("same-signature", { blockTime: 350, fromUserAccount: authority, toUserAccount: key(60), type: "zeta" }),
    transfer("same-signature", { blockTime: null, fromUserAccount: key(61), toUserAccount: authority, type: "alpha" }),
    transfer("sig-3", { blockTime: 90, fromUserAccount: authority, toUserAccount: authority, type: null }),
    transfer("sig-4", { blockTime: undefined, fromUserAccount: key(62), toUserAccount: key(63), type: "alpha" }),
    transfer("sig-5", { blockTime: 250, fromUserAccount: null, toUserAccount: authority, type: "transfer" }),
    transfer("sig-6", { blockTime: 150, fromUserAccount: undefined, toUserAccount: undefined, type: "transfer" }),
    transfer("sig-7", { blockTime: 100, fromUserAccount: undefined, toUserAccount: undefined, type: undefined }),
    transfer("sig-8", { blockTime: null, fromUserAccount: undefined, toUserAccount: undefined, type: "unknown" }),
  ];
  const result = await run(plan, async () => ({ observations, paginationToken: null }));
  const metric = result.metrics.authorities[0];
  assert.equal(metric.acceptedObservationCount.value, 8);
  assert.equal(metric.acceptedObservationCount.queryCompleteness, "complete");
  assert.equal(metric.usableBlockTimeCount.value, 5);
  assert.equal(metric.missingBlockTimeCount.value, 3);
  assert.deepEqual(metric.observedBlockTimeBounds.value, {
    minimumUnixSeconds: 90,
    maximumUnixSeconds: 350,
    spanSeconds: 260,
  });
  assert.equal(metric.distinctSignatureCount.value, 7);
  assert.equal(metric.acceptedObservationCount.value, 8, "duplicate signatures do not remove observations");
  assert.deepEqual(metric.reportedTransferTypeCounts.value, [
    { availability: "missing", reportedType: null, count: 1 },
    { availability: "null", reportedType: null, count: 1 },
    { availability: "reported", reportedType: "alpha", count: 2 },
    { availability: "reported", reportedType: "transfer", count: 2 },
    { availability: "reported", reportedType: "unknown", count: 1 },
    { availability: "reported", reportedType: "zeta", count: 1 },
  ]);
  assert.deepEqual(metric.reportedEndpointRelationshipCounts.value, {
    reportedInbound: 2,
    reportedOutbound: 1,
    reportedSelfDirected: 1,
    ambiguous: 4,
  });
  assert.equal(metric.observedBlockTimeBounds.value.minimumUnixSeconds < plan.requestedWindow.fromUnixSecondsInclusive, true);
  assert.equal(metric.observedBlockTimeBounds.value.maximumUnixSeconds >= plan.requestedWindow.toUnixSecondsExclusive, true);
});

test("successful naturally terminated empty history yields complete zero counts, but no time bounds", async () => {
  const plan = makePlan([100], 1);
  const { metrics } = await run(plan, async () => ({ observations: [], paginationToken: null }));
  const metric = metrics.authorities[0];
  for (const name of [
    "acceptedObservationCount",
    "usableBlockTimeCount",
    "missingBlockTimeCount",
    "distinctSignatureCount",
  ]) {
    assert.deepEqual(metric[name], { status: "available", value: 0, queryCompleteness: "complete" });
  }
  assert.deepEqual(metric.reportedTransferTypeCounts, { status: "available", value: [], queryCompleteness: "complete" });
  assert.deepEqual(metric.reportedEndpointRelationshipCounts, {
    status: "available",
    value: { reportedInbound: 0, reportedOutbound: 0, reportedSelfDirected: 0, ambiguous: 0 },
    queryCompleteness: "complete",
  });
  assert.deepEqual(metric.observedBlockTimeBounds, { status: "unavailable", value: null, reason: "no_usable_block_times" });
});

test("truncated authority exposes partial metrics", async () => {
  const plan = makePlan([100], 1, { maxPagesPerAuthority: 1 });
  const { metrics } = await run(plan, async () => ({ observations: [transfer("partial")], paginationToken: CURSOR }));
  const metric = metrics.authorities[0];
  assert.equal(metric.queryStatus, "success");
  assert.equal(metric.paginationStatus, "truncated");
  assert.equal(metric.acceptedObservationCount.queryCompleteness, "partial");
});

test("provider error before observations is unavailable instead of zero", async () => {
  const plan = makePlan([100], 1);
  const { metrics } = await run(plan, async () => { throw new HeliusTransferProviderError("transport", "safe"); });
  const metric = metrics.authorities[0];
  assert.equal(metric.queryStatus, "provider_error");
  for (const name of [
    "acceptedObservationCount",
    "usableBlockTimeCount",
    "missingBlockTimeCount",
    "observedBlockTimeBounds",
    "distinctSignatureCount",
    "reportedTransferTypeCounts",
    "reportedEndpointRelationshipCounts",
  ]) {
    assert.deepEqual(metric[name], { status: "unavailable", value: null, reason: "provider_error" });
  }
});

test("provider error after accepted observations preserves partial metrics", async () => {
  const plan = makePlan([100], 1);
  let request = 0;
  const { metrics } = await run(plan, async () => {
    request += 1;
    if (request === 1) return { observations: [transfer("retained", { blockTime: 120 })], paginationToken: CURSOR };
    throw new HeliusTransferProviderError("http", "safe");
  });
  const metric = metrics.authorities[0];
  assert.equal(metric.queryStatus, "provider_error");
  assert.equal(metric.acceptedObservationCount.value, 1);
  assert.equal(metric.acceptedObservationCount.queryCompleteness, "partial");
});

test("unqueried authorities are unavailable and sample coverage keeps states distinct", async () => {
  const plan = makePlan([100, 90, 80, 70], 3, { maxPagesPerAuthority: 1 });
  const selected = plan.candidateAuthorities.filter((candidate) => candidate.plannedDisposition.status === "selected");
  let index = 0;
  const { metrics } = await run(plan, async () => {
    const candidate = selected[index++];
    if (candidate === selected[0]) return { observations: [transfer("complete")], paginationToken: null };
    if (candidate === selected[1]) return { observations: [transfer("truncated")], paginationToken: CURSOR };
    throw new HeliusTransferProviderError("transport", "safe");
  });
  assert.deepEqual(metrics.sampleCoverage, {
    candidateAuthorityCount: 4,
    selectedAuthorityCount: 3,
    queriedAuthorityCount: 3,
    naturallyCompleteAuthorityCount: 1,
    truncatedAuthorityCount: 1,
    providerErrorAuthorityCount: 1,
    unqueriedAuthorityCount: 1,
  });
  const unqueried = metrics.authorities.find((authority) => authority.queryStatus === "not_queried");
  assert.deepEqual(unqueried.acceptedObservationCount, { status: "unavailable", value: null, reason: "not_queried" });
});

test("rejects plan/evidence mint, window, candidate-frame, and selection mismatches", async () => {
  const plan = makePlan([100, 90], 1);
  const { execution } = await run(plan, async () => ({ observations: [], paginationToken: null }));
  const clone = () => structuredClone(execution.evidence);

  const mintMismatch = clone();
  mintMismatch.mintAddress = key(99);
  assert.throws(() => calculateSolanaHistoricalDescriptiveMetrics(plan, mintMismatch), /chain or mint/);

  const windowMismatch = clone();
  windowMismatch.provenance.requestedWindow.toUnixSecondsExclusive += 1;
  assert.throws(() => calculateSolanaHistoricalDescriptiveMetrics(plan, windowMismatch), /requested windows/);

  const frameMismatch = clone();
  frameMismatch.authorities.pop();
  assert.throws(() => calculateSolanaHistoricalDescriptiveMetrics(plan, frameMismatch), /candidate frames/);

  const dispositionMismatch = clone();
  const selectedIndex = plan.candidateAuthorities.findIndex((candidate) => candidate.plannedDisposition.status === "selected");
  dispositionMismatch.authorities[selectedIndex] = {
    authorityAddress: plan.candidateAuthorities[selectedIndex].authorityAddress,
    queryStatus: "not_queried",
    reason: "not_selected",
    paginationStatus: "not_applicable",
    terminalReason: "not_queried",
    requestCount: 0,
    pages: [],
    observations: [],
    providerError: null,
  };
  assert.throws(() => calculateSolanaHistoricalDescriptiveMetrics(plan, dispositionMismatch), /selected historical authority/);

  const unselectedIndex = plan.candidateAuthorities.findIndex((candidate) => candidate.plannedDisposition.status === "not_selected");
  const budgetLimited = clone();
  budgetLimited.authorities[unselectedIndex].reason = "budget_limit";
  const budgetLimitedMetrics = calculateSolanaHistoricalDescriptiveMetrics(plan, budgetLimited);
  assert.deepEqual(budgetLimitedMetrics.authorities[unselectedIndex].acceptedObservationCount, {
    status: "unavailable",
    value: null,
    reason: "not_queried",
  });

  const unselectedWithResults = clone();
  unselectedWithResults.authorities[unselectedIndex] = {
    authorityAddress: plan.candidateAuthorities[unselectedIndex].authorityAddress,
    queryStatus: "success",
    paginationStatus: "complete",
    terminalReason: "natural_termination",
    requestCount: 1,
    pages: [{
      pageNumber: 1,
      requestLimit: 20,
      recordCount: 0,
      startRecordIndex: 0,
      endRecordIndexExclusive: 0,
      continuationTokenUsed: false,
      continuationTokenReturned: false,
      firstUsableBlockTime: null,
      lastUsableBlockTime: null,
      minimumUsableBlockTime: null,
      maximumUsableBlockTime: null,
      recordsWithoutUsableBlockTime: 0,
    }],
    observations: [],
    providerError: null,
  };
  assert.throws(() => calculateSolanaHistoricalDescriptiveMetrics(plan, unselectedWithResults), /query disposition/);
});

test("is deterministic and does not mutate plan or evidence", async () => {
  const plan = makePlan([100], 1);
  const { execution } = await run(plan, async () => ({
    observations: [transfer("b", { blockTime: 170, type: "z" }), transfer("a", { blockTime: 130, type: "a" })],
    paginationToken: null,
  }));
  const planBefore = structuredClone(plan);
  const evidenceBefore = structuredClone(execution.evidence);
  const first = calculateSolanaHistoricalDescriptiveMetrics(plan, execution.evidence);
  const second = calculateSolanaHistoricalDescriptiveMetrics(plan, execution.evidence);
  assert.deepEqual(first, second);
  assert.deepEqual(plan, planBefore);
  assert.deepEqual(execution.evidence, evidenceBefore);
});
