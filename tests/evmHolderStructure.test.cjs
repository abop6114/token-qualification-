const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeEvmHolderStructure } = require("../dist/normalization/evmHolderStructure.js");

const CONTRACT = "0x1234567890abcdef1234567890abcdef12345678";
const ADDRESS_A = "0x0000000000000000000000000000000000000001";
const ADDRESS_B = "0x0000000000000000000000000000000000000002";
const ADDRESS_C = "0x0000000000000000000000000000000000000003";
const FETCHED_AT = "2026-10-06T12:00:00.000Z";

function tokenEvidence({ chain = "base", contractAddress = CONTRACT, block = "0x64", totalSupply, ...overrides } = {}) {
  const blockUnavailable = block === null;
  const supply = totalSupply ?? (blockUnavailable
    ? { status: "not_attempted", value: null, reason: "block_unavailable" }
    : "25");
  return {
    schemaVersion: "evm-token-contract-evidence-v1",
    chain,
    submittedAddress: contractAddress,
    contractAddress,
    provenance: {
      chain,
      provider: "alchemy",
      fetchedAt: FETCHED_AT,
      observationBlock: blockUnavailable
        ? { status: "provider_error", blockNumber: null, error: { category: "transport", httpStatus: null, rpcCode: null, message: "safe" } }
        : { status: "available", blockNumber: block, basis: "eth_blockNumber" },
    },
    contractCode: blockUnavailable
      ? { status: "not_attempted", reason: "block_unavailable" }
      : { status: "present", byteLength: 1, basis: "eth_getCode" },
    totalSupply: typeof supply === "string"
      ? { status: "available", value: supply, basis: "eth_call" }
      : supply,
    decimals: { status: "available", value: 0, basis: "eth_call" },
    name: { status: "not_attempted", value: null, reason: "no_contract_code" },
    symbol: { status: "not_attempted", value: null, reason: "no_contract_code" },
    ...overrides,
  };
}

function holderEvidence(rows = [], overrides = {}) {
  const positiveCount = rows.filter((row) => BigInt(row.rawBalance) > 0n).length;
  const page = {
    requestedPageNumber: 0,
    providerRecordsReturned: rows.length,
    recordsRetained: rows.length,
    providerReportedPageSize: 100,
    providerHasMore: false,
  };
  const base = {
    schemaVersion: "evm-holder-evidence-v1",
    chain: "base",
    tokenContractAddress: CONTRACT,
    provenance: {
      chain: "base",
      provider: "goldrush",
      providerChainSlug: "base-mainnet",
      tokenContractAddress: CONTRACT,
      requestedObservationBlock: "100",
      providerReportedObservationBlock: "100",
      providerBlockRelation: "match",
      fetchedAt: FETCHED_AT,
    },
    holders: rows,
    providerReportedHolderCount: String(rows.length),
    observedHolderRecordCount: rows.length,
    observedPositiveBalanceAddressCount: positiveCount,
    pagination: {
      maxPages: 1,
      maxRecords: 100,
      requestedPageSize: 100,
      pagesRequested: 1,
      pagesReturned: 1,
      providerRecordsReturned: rows.length,
      recordsRetained: rows.length,
      providerReportedHolderCount: String(rows.length),
      providerReportedPageSize: 100,
      providerHasMore: false,
      terminalReason: "natural_termination",
      pages: [page],
    },
    coverage: { status: "provider_complete" },
    failure: null,
  };
  return {
    ...base,
    ...overrides,
    provenance: { ...base.provenance, ...(overrides.provenance || {}) },
    pagination: { ...base.pagination, ...(overrides.pagination || {}) },
  };
}

function rowsToEvidence(rows, options = {}) {
  return normalizeEvmHolderStructure(tokenEvidence(options.token), holderEvidence(rows, options.holders));
}

test("validates chain and normalized contract identity across Alchemy and GoldRush evidence", () => {
  const token = tokenEvidence({ contractAddress: `0x${CONTRACT.slice(2).toUpperCase()}` });
  const holders = holderEvidence([{ address: ADDRESS_A, rawBalance: "25" }]);
  const result = normalizeEvmHolderStructure(token, holders);
  assert.equal(result.tokenContractAddress, CONTRACT);

  assert.throws(() => normalizeEvmHolderStructure(tokenEvidence({ contractAddress: ADDRESS_A }), holders), /contracts do not match/);
  assert.throws(() => normalizeEvmHolderStructure(tokenEvidence({ chain: "ethereum" }), holders), /chains do not match/);
});

test("rejects Step 1 schema, provider, code, block, and supply contradictions before concentration", () => {
  const rows = [{ address: ADDRESS_A, rawBalance: "25" }];
  const badInputs = [
    ["wrong schema", tokenEvidence({ schemaVersion: "other" })],
    ["wrong provider", tokenEvidence({ provenance: { provider: "other" } })],
    ["no code with attempted supply", tokenEvidence({ contractCode: { status: "no_code", byteLength: 0, basis: "eth_getCode" } })],
    ["malformed code length", tokenEvidence({ contractCode: { status: "present", byteLength: 0, basis: "eth_getCode" } })],
    ["wrong block basis", tokenEvidence({ provenance: { observationBlock: { status: "available", blockNumber: "0x64", basis: "eth_call" } } })],
    ["block above uint256", tokenEvidence({ block: `0x${"1"}${"0".repeat(64)}` })],
    ["wrong supply basis", tokenEvidence({ totalSupply: { status: "available", value: "25", basis: "eth_getCode" } })],
    ["malformed available supply", tokenEvidence({ totalSupply: { status: "available", value: "025", basis: "eth_call" } })],
  ];
  for (const [label, token] of badInputs) {
    assert.throws(() => normalizeEvmHolderStructure(token, holderEvidence(rows)), undefined, label);
  }
});

test("preserves valid no-code and valid unavailable Step 1 outcomes without unlocking concentration", () => {
  const noCode = tokenEvidence({
    contractCode: { status: "no_code", byteLength: 0, basis: "eth_getCode" },
    totalSupply: { status: "not_attempted", value: null, reason: "no_contract_code" },
  });
  const result = normalizeEvmHolderStructure(noCode, holderEvidence([{ address: ADDRESS_A, rawBalance: "25" }]));
  assert.equal(result.supplyReconciliation.status, "unknown");
  assert.equal(result.topNSupplyConcentration.top1.status, "unavailable");
  assert.equal(result.topNSupplyConcentration.top1.reason, "total_supply_unavailable");
});

test("reports exact reconciliation and available supply concentration only with complete comparable evidence", () => {
  const result = rowsToEvidence([
    { address: ADDRESS_A, rawBalance: "15" },
    { address: ADDRESS_B, rawBalance: "10" },
  ]);
  assert.equal(result.supplyReconciliation.status, "reconciled");
  assert.equal(result.supplyReconciliation.observedPositiveBalanceRaw, "25");
  assert.equal(result.supplyReconciliation.totalSupplyRaw, "25");
  assert.deepEqual(result.goldRushCoverage, { status: "provider_complete" });
  assert.deepEqual(result.topNBalanceNumeratorsRaw, { top1: "15", top5: "25", top10: "25", top20: "25" });
  assert.deepEqual(result.topNSupplyConcentration.top1, {
    status: "available", topN: 1, numeratorRaw: "15", denominatorRaw: "25", denominatorBasis: "total_supply", percentage: "60.000000",
  });
  assert.equal(result.topNSupplyConcentration.top20.percentage, "100.000000");
});

test("reports observed balances below supply without making concentration available", () => {
  const result = rowsToEvidence([{ address: ADDRESS_A, rawBalance: "20" }], { token: { totalSupply: "25" } });
  assert.equal(result.supplyReconciliation.status, "less_than_supply");
  assert.equal(result.topNSupplyConcentration.top1.status, "unavailable");
  assert.equal(result.topNSupplyConcentration.top1.reason, "supply_not_reconciled");
  assert.equal(result.topNSupplyConcentration.top1.numeratorRaw, "20");
});

test("reports observed balances greater than supply without making concentration available", () => {
  const result = rowsToEvidence([{ address: ADDRESS_A, rawBalance: "26" }], { token: { totalSupply: "25" } });
  assert.equal(result.supplyReconciliation.status, "greater_than_supply");
  assert.equal(result.topNSupplyConcentration.top1.status, "unavailable");
  assert.equal(result.topNSupplyConcentration.top1.reason, "supply_not_reconciled");
});

test("keeps zero-balance rows out of balance-bearing ranking while preserving observed row counts", () => {
  const result = rowsToEvidence([
    { address: ADDRESS_A, rawBalance: "0" },
    { address: ADDRESS_B, rawBalance: "10" },
    { address: ADDRESS_C, rawBalance: "15" },
  ]);
  assert.equal(result.observedHolderRecordCount, 3);
  assert.equal(result.balanceBearingAddressCount, 2);
  assert.equal(result.observedPositiveBalanceRaw, "25");
  assert.deepEqual(result.rankedBalanceBearingAddresses.map((row) => row.address), [ADDRESS_C, ADDRESS_B]);
});

test("sorts equal balances by normalized address and handles fewer than twenty positive addresses", () => {
  const result = rowsToEvidence([
    { address: ADDRESS_C, rawBalance: "10" },
    { address: ADDRESS_A, rawBalance: "10" },
    { address: ADDRESS_B, rawBalance: "5" },
  ]);
  assert.deepEqual(result.rankedBalanceBearingAddresses.map((row) => row.address), [ADDRESS_A, ADDRESS_C, ADDRESS_B]);
  assert.deepEqual(result.topNBalanceNumeratorsRaw, { top1: "10", top5: "25", top10: "25", top20: "25" });
});

test("does not reconcile across unavailable or mismatched observation blocks", () => {
  const rows = [{ address: ADDRESS_A, rawBalance: "25" }];
  const noAlchemyBlock = rowsToEvidence(rows, { token: { block: null } });
  assert.equal(noAlchemyBlock.supplyReconciliation.status, "not_comparable");
  assert.equal(noAlchemyBlock.supplyReconciliation.reason, "alchemy_block_unavailable");

  const mismatch = rowsToEvidence(rows, { holders: {
    provenance: { providerReportedObservationBlock: "99", providerBlockRelation: "mismatch" },
  } });
  assert.equal(mismatch.supplyReconciliation.status, "not_comparable");
  assert.equal(mismatch.supplyReconciliation.reason, "observation_block_mismatch");
  assert.equal(mismatch.topNSupplyConcentration.top1.reason, "observation_block_mismatch");

  const unreported = rowsToEvidence(rows, { holders: {
    provenance: { providerReportedObservationBlock: null, providerBlockRelation: "not_reported" },
  } });
  assert.equal(unreported.supplyReconciliation.status, "not_comparable");
  assert.equal(unreported.supplyReconciliation.reason, "goldrush_block_not_reported");
});

test("valid unavailable and malformed total-supply outcomes remain unknown", () => {
  const rows = [{ address: ADDRESS_A, rawBalance: "25" }];
  const unavailable = rowsToEvidence(rows, { token: {
    totalSupply: { status: "provider_error", value: null, error: { category: "rpc", httpStatus: null, rpcCode: 3, message: "sanitized" } },
  } });
  assert.equal(unavailable.supplyReconciliation.status, "unknown");
  assert.equal(unavailable.supplyReconciliation.reason, "total_supply_unavailable");
  assert.equal(unavailable.topNSupplyConcentration.top1.reason, "total_supply_unavailable");

  const malformedOutcome = rowsToEvidence(rows, { token: {
    totalSupply: { status: "malformed", value: null, reason: "malformed_abi" },
  } });
  assert.equal(malformedOutcome.supplyReconciliation.status, "unknown");
  assert.equal(malformedOutcome.supplyReconciliation.reason, "total_supply_malformed");
  assert.equal(malformedOutcome.topNSupplyConcentration.top1.reason, "total_supply_malformed");

  for (const totalSupply of [
    { status: "available", value: "01", basis: "eth_call" },
    { status: "available", value: "1", basis: "eth_getCode" },
  ]) {
    assert.throws(() => rowsToEvidence(rows, { token: { totalSupply } }), /available total-supply evidence is malformed/);
  }
});

test("accepts only the defined EvmHolderCoverage status and reason combinations", () => {
  const rows = [{ address: ADDRESS_A, rawBalance: "25" }];
  const valid = [
    { status: "provider_complete" },
    { status: "partial", reason: "resource_limited" },
    { status: "partial", reason: "provider_error" },
    { status: "partial", reason: "malformed_response" },
    { status: "unavailable", reason: "provider_error" },
    { status: "malformed", reason: "malformed_response" },
  ];
  for (const coverage of valid) {
    assert.doesNotThrow(() => rowsToEvidence(rows, { holders: { coverage } }));
  }

  const invalid = [
    { status: "provider_complete", reason: "provider_error" },
    { status: "partial", reason: "unexpected" },
    { status: "partial" },
    { status: "unavailable", reason: "resource_limited" },
    { status: "unavailable" },
    { status: "malformed", reason: "provider_error" },
    { status: "malformed" },
    { status: "unknown", reason: "provider_error" },
  ];
  for (const coverage of invalid) {
    assert.throws(() => rowsToEvidence(rows, { holders: { coverage } }), /coverage state is malformed/);
  }
});

test("zero supply can reconcile zero observed balance but never yields a percentage", () => {
  const result = rowsToEvidence([{ address: ADDRESS_A, rawBalance: "0" }], { token: { totalSupply: "0" } });
  assert.equal(result.supplyReconciliation.status, "reconciled");
  assert.equal(result.observedPositiveBalanceRaw, "0");
  assert.equal(result.balanceBearingAddressCount, 0);
  assert.equal(result.topNSupplyConcentration.top1.status, "unavailable");
  assert.equal(result.topNSupplyConcentration.top1.reason, "zero_supply");
  assert.equal(result.topNSupplyConcentration.top1.numeratorRaw, "0");
});

test("partial or provider-error holder evidence never passes the concentration completeness gate", () => {
  const rows = [{ address: ADDRESS_A, rawBalance: "25" }];
  const partial = rowsToEvidence(rows, { holders: {
    coverage: { status: "partial", reason: "resource_limited" },
    pagination: { terminalReason: "record_cap", providerHasMore: true, pages: [{
      requestedPageNumber: 0, providerRecordsReturned: 1, recordsRetained: 1, providerReportedPageSize: 100, providerHasMore: true,
    }] },
  } });
  assert.equal(partial.supplyReconciliation.status, "reconciled");
  assert.deepEqual(partial.goldRushCoverage, { status: "partial", reason: "resource_limited" });
  assert.equal(partial.topNSupplyConcentration.top1.status, "unavailable");
  assert.equal(partial.topNSupplyConcentration.top1.reason, "holder_coverage_incomplete");

  const failed = rowsToEvidence(rows, { holders: {
    coverage: { status: "partial", reason: "provider_error" },
    failure: { category: "http", httpStatus: 503, message: "sanitized" },
    pagination: { terminalReason: "provider_error", providerHasMore: true, pages: [{
      requestedPageNumber: 0, providerRecordsReturned: 1, recordsRetained: 1, providerReportedPageSize: 100, providerHasMore: true,
    }] },
  } });
  assert.equal(failed.supplyReconciliation.status, "reconciled");
  assert.equal(failed.topNSupplyConcentration.top1.status, "unavailable");
  assert.equal(failed.topNSupplyConcentration.top1.reason, "holder_coverage_incomplete");
});

test("uint256-scale supplies, holder totals, and numerators remain exact", () => {
  const max = (1n << 256n) - 1n;
  const lower = max / 2n;
  const upper = max - lower;
  const result = rowsToEvidence([
    { address: ADDRESS_A, rawBalance: lower.toString() },
    { address: ADDRESS_B, rawBalance: upper.toString() },
  ], { token: { totalSupply: max.toString() } });
  assert.equal(result.supplyReconciliation.status, "reconciled");
  assert.equal(result.observedPositiveBalanceRaw, max.toString());
  assert.equal(result.topNBalanceNumeratorsRaw.top1, upper.toString());
  assert.equal(result.topNSupplyConcentration.top1.percentage, "50.000000");
});

test("rounds an exact half-micro-percent boundary up to six decimal places", () => {
  const rows = [
    { address: ADDRESS_A, rawBalance: "10000001" },
    ...Array.from({ length: 18 }, (_, index) => ({ address: `0x${(index + 10).toString(16).padStart(40, "0")}`, rawBalance: "10000000" })),
    { address: ADDRESS_C, rawBalance: "9999999" },
  ];
  const result = rowsToEvidence(rows, { token: { totalSupply: "200000000" } });
  assert.equal(result.supplyReconciliation.status, "reconciled");
  assert.equal(result.topNSupplyConcentration.top1.numeratorRaw, "10000001");
  assert.equal(result.topNSupplyConcentration.top1.percentage, "5.000001");
});

test("rejects internally inconsistent holder counts and duplicate normalized addresses", () => {
  const baseRows = [{ address: ADDRESS_A, rawBalance: "10" }];
  assert.throws(() => rowsToEvidence(baseRows, { holders: { observedPositiveBalanceAddressCount: 0 } }), /positive-address count/);
  assert.throws(() => rowsToEvidence([
    { address: ADDRESS_A, rawBalance: "10" },
    { address: ADDRESS_A.toUpperCase().replace("0X", "0x"), rawBalance: "10" },
  ]), /duplicate normalized addresses/);
});
