const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeEvmAddressBalanceDistribution } = require("../dist/normalization/evmAddressBalanceDistribution.js");
const { normalizeEvmHolderStructure } = require("../dist/normalization/evmHolderStructure.js");
const { normalizeOwnerAuthorityBalanceDistribution } = require("../dist/normalization/ownerAuthorityBalanceDistribution.js");

const CONTRACT = "0x1234567890abcdef1234567890abcdef12345678";
const FETCHED_AT = "2026-10-07T12:00:00.000Z";
const MAX_UINT256 = ((1n << 256n) - 1n).toString();

function address(index) {
  return `0x${BigInt(index).toString(16).padStart(40, "0")}`;
}

function tokenEvidence(chain, supply) {
  return {
    schemaVersion: "evm-token-contract-evidence-v1",
    chain,
    submittedAddress: CONTRACT,
    contractAddress: CONTRACT,
    provenance: {
      chain,
      provider: "alchemy",
      fetchedAt: FETCHED_AT,
      observationBlock: { status: "available", blockNumber: "0x64", basis: "eth_blockNumber" },
    },
    contractCode: { status: "present", byteLength: 1, basis: "eth_getCode" },
    totalSupply: { status: "available", value: supply, basis: "eth_call" },
    decimals: { status: "available", value: 0, basis: "eth_call" },
    name: { status: "not_attempted", value: null, reason: "no_contract_code" },
    symbol: { status: "not_attempted", value: null, reason: "no_contract_code" },
  };
}

function holderEvidence(rows, { chain = "base", coverage = { status: "provider_complete" }, mode = "complete" } = {}) {
  const providerChainSlug = chain === "base" ? "base-mainnet" : "eth-mainnet";
  const pageHasMore = mode === "partial" || mode === "page_cap" || mode === "page_and_record_caps"
    || mode === "provider_error_after_page" || mode === "malformed_after_page";
  const pages = mode === "unavailable" || mode === "malformed" ? [] : [{
    requestedPageNumber: 0,
    providerRecordsReturned: mode === "record_cap_final_page" ? rows.length + 1 : rows.length,
    recordsRetained: rows.length,
    providerReportedPageSize: 100,
    providerHasMore: pageHasMore,
  }];
  const providerCount = mode === "unavailable" || mode === "malformed" ? null
    : mode === "malformed_after_page" || mode === "record_cap_final_page" ? String(rows.length + 1) : String(rows.length);
  const failure = mode === "unavailable"
    ? { category: "http", httpStatus: 503, message: "GoldRush HTTP request failed." }
    : mode === "malformed"
      ? { category: "malformed_response", httpStatus: null, message: "GoldRush response was malformed." }
      : mode === "malformed_after_page"
        ? { category: "malformed_response", httpStatus: null, message: "GoldRush response was malformed." }
      : mode === "provider_error_after_page"
        ? { category: "http", httpStatus: 503, message: "GoldRush HTTP request failed." }
        : null;
  const pagination = {
    maxPages: mode === "page_cap" || mode === "page_and_record_caps" ? 1 : 3,
    maxRecords: mode === "partial" || mode === "page_and_record_caps" || mode === "record_cap_final_page" ? rows.length : 100,
    requestedPageSize: 100,
    pagesRequested: mode === "provider_error_after_page" || mode === "malformed_after_page" ? 2 : mode === "unavailable" || mode === "malformed" ? 1 : pages.length,
    pagesReturned: mode === "malformed_after_page" ? 2 : pages.length,
    providerRecordsReturned: mode === "unavailable" || mode === "malformed" ? 0
      : mode === "malformed_after_page" || mode === "record_cap_final_page" ? rows.length + 1 : rows.length,
    recordsRetained: rows.length,
    providerReportedHolderCount: mode === "malformed_after_page" || mode === "record_cap_final_page"
      ? String(rows.length + 1) : providerCount,
    providerReportedPageSize: pages.length > 0 ? 100 : null,
    providerHasMore: pages.length > 0 ? pageHasMore : null,
    terminalReason: mode === "complete" || mode === "empty" ? "natural_termination"
      : mode === "partial" ? "record_cap"
        : mode === "page_cap" ? "page_cap"
          : mode === "page_and_record_caps" ? "page_and_record_caps"
              : mode === "record_cap_final_page" ? "record_cap"
            : mode === "provider_error_after_page" || mode === "unavailable" ? "provider_error" : "malformed_response",
    pages,
  };
  return {
    schemaVersion: "evm-holder-evidence-v1",
    chain,
    tokenContractAddress: CONTRACT,
    provenance: {
      chain,
      provider: "goldrush",
      providerChainSlug,
      tokenContractAddress: CONTRACT,
      requestedObservationBlock: "100",
      providerReportedObservationBlock: "100",
      providerBlockRelation: "match",
      fetchedAt: FETCHED_AT,
    },
    holders: rows,
    providerReportedHolderCount: providerCount,
    observedHolderRecordCount: rows.length,
    observedPositiveBalanceAddressCount: rows.filter((row) => BigInt(row.rawBalance) > 0n).length,
    pagination,
    coverage,
    failure,
  };
}

function fixture(balanceStrings, options = {}) {
  const rows = balanceStrings.map((rawBalance, index) => ({ address: address(index + 1), rawBalance }));
  const coverage = options.coverage ?? { status: "provider_complete" };
  const mode = options.mode ?? (balanceStrings.length === 0 ? "empty" : "complete");
  const evidence = holderEvidence(rows, { chain: options.chain ?? "base", coverage, mode });
  const sum = rows.reduce((total, row) => total + BigInt(row.rawBalance), 0n);
  const supply = options.supply ?? (sum === 0n ? "0" : sum.toString());
  const structure = normalizeEvmHolderStructure(tokenEvidence(evidence.chain, supply), evidence);
  return { evidence, structure, result: normalizeEvmAddressBalanceDistribution(evidence, structure) };
}

function numericMetrics(result) {
  assert.equal(result.status, "available");
  return {
    observedPositiveAddressCount: result.observedPositiveAddressCount,
    observedPositiveBalanceRaw: result.observedPositiveBalanceRaw,
    minimumBalanceRaw: result.minimumBalanceRaw,
    maximumBalanceRaw: result.maximumBalanceRaw,
    quantilesRaw: result.quantilesRaw,
    distinctBalanceCount: result.distinctBalanceCount,
    repeatedBalanceGroupCount: result.repeatedBalanceGroupCount,
    addressesInRepeatedBalanceGroups: result.addressesInRepeatedBalanceGroups,
    addressShareInRepeatedBalanceGroups: result.addressShareInRepeatedBalanceGroups,
    repeatedBalanceGroups: result.repeatedBalanceGroups,
    repeatedBalanceGroupsOmitted: result.repeatedBalanceGroupsOmitted,
    cumulativeAddressBalanceProfile: result.cumulativeAddressBalanceProfile,
  };
}

test("matches Solana portable numeric metrics while keeping EVM population and coverage labels distinct", () => {
  const balances = ["1", "2", "2", "7", "7", "7", "50", "100"];
  const evm = fixture(balances).result;
  const solana = normalizeOwnerAuthorityBalanceDistribution({
    chain: "solana",
    assetAddress: "11111111111111111111111111111111",
    snapshotAt: FETCHED_AT,
    decimals: 0,
    currentSupplyRaw: "176",
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 1, contextSlots: [100] },
    amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null },
    rawOwnerCount: balances.length,
    rawOwnerAuthorities: balances.map((balanceRaw) => ({ balanceRaw })),
  });
  assert.equal(evm.population, "positive_balance_addresses");
  assert.equal(solana.population, "positive_owner_authorities");
  assert.equal(evm.sourceCoverage.status, "provider_complete");
  assert.deepEqual(evm.quantilesRaw, solana.quantilesRaw);
  assert.equal(evm.observedPositiveAddressCount, solana.observedOwnerAuthorityCount);
  assert.equal(evm.observedPositiveBalanceRaw, solana.observedPositiveOwnerAuthorityBalanceRaw);
  assert.equal(evm.minimumBalanceRaw, solana.minimumBalanceRaw);
  assert.equal(evm.maximumBalanceRaw, solana.maximumBalanceRaw);
  assert.equal(evm.distinctBalanceCount, solana.distinctBalanceCount);
  assert.equal(evm.repeatedBalanceGroupCount, solana.repeatedBalanceGroupCount);
  assert.equal(evm.addressesInRepeatedBalanceGroups, solana.authoritiesInRepeatedBalanceGroups);
  assert.equal(evm.addressShareInRepeatedBalanceGroups, solana.authorityShareInRepeatedBalanceGroups);
  assert.deepEqual(evm.repeatedBalanceGroups.map(({ balanceRaw, addressCount }) => ({ balanceRaw, ownerAuthorityCount: addressCount })), solana.repeatedBalanceGroups);
  assert.deepEqual(evm.cumulativeAddressBalanceProfile.map((point) => ({
    percentile: point.addressPercentile,
    count: point.includedAddressCount,
    raw: point.cumulativeObservedBalanceRaw,
    share: point.cumulativeObservedBalanceShare,
  })), solana.cumulativeOwnerBalanceProfile.map((point) => ({
    percentile: point.ownerPercentile,
    count: point.includedOwnerAuthorityCount,
    raw: point.cumulativeObservedBalanceRaw,
    share: point.cumulativeObservedBalanceShare,
  })));
});

test("is independent of holder row input order and retains source provenance and pagination", () => {
  const balances = ["4", "9", "4", "1", "1"];
  const first = fixture(balances);
  const reversedRows = [...first.evidence.holders].reverse();
  const evidence = { ...first.evidence, holders: reversedRows };
  const structure = normalizeEvmHolderStructure(tokenEvidence("base", "19"), evidence);
  const reversed = normalizeEvmAddressBalanceDistribution(evidence, structure);
  assert.deepEqual(numericMetrics(reversed), numericMetrics(first.result));
  assert.deepEqual(reversed.sourceProvenance, first.evidence.provenance);
  assert.deepEqual(reversed.sourcePagination, first.evidence.pagination);
});

test("preserves exact balances above Number.MAX_SAFE_INTEGER and at uint256 maximum", () => {
  const values = ["9007199254740993", "9007199254740992"];
  const large = fixture(values).result;
  assert.equal(large.observedPositiveBalanceRaw, "18014398509481985");
  assert.equal(large.minimumBalanceRaw, "9007199254740992");
  assert.equal(large.maximumBalanceRaw, "9007199254740993");
  const max = fixture([MAX_UINT256]).result;
  assert.equal(max.minimumBalanceRaw, MAX_UINT256);
  assert.equal(max.maximumBalanceRaw, MAX_UINT256);
  assert.equal(max.observedPositiveBalanceRaw, MAX_UINT256);
  assert.throws(() => fixture([((1n << 256n)).toString()]), /uint256|malformed/);
});

test("uses nearest-rank quantiles without interpolation for small, odd, and even populations", () => {
  const one = fixture(["42"]).result;
  assert.deepEqual(one.quantilesRaw, { p25: "42", p50: "42", p75: "42", p90: "42", p99: "42" });
  const odd = fixture(["1", "2", "3", "4", "100"]).result;
  assert.deepEqual(odd.quantilesRaw, { p25: "2", p50: "3", p75: "4", p90: "100", p99: "100" });
  const even = fixture(["1", "2", "3", "100"]).result;
  assert.deepEqual(even.quantilesRaw, { p25: "1", p50: "2", p75: "3", p90: "100", p99: "100" });
  assert.equal(even.minimumBalanceRaw, "1");
  assert.equal(even.maximumBalanceRaw, "100");
});

test("calculates uncapped repeated-balance aggregates and caps the deterministic listing at 25", () => {
  const balances = [];
  for (let value = 1; value <= 26; value += 1) balances.push(String(value), String(value));
  const result = fixture(balances).result;
  assert.equal(result.distinctBalanceCount, 26);
  assert.equal(result.repeatedBalanceGroupCount, 26);
  assert.equal(result.addressesInRepeatedBalanceGroups, 52);
  assert.equal(result.addressShareInRepeatedBalanceGroups, "100.000000");
  assert.equal(result.repeatedBalanceGroups.length, 25);
  assert.equal(result.repeatedBalanceGroupsOmitted, 1);
  assert.deepEqual(result.repeatedBalanceGroups.slice(0, 3), [
    { balanceRaw: "1", addressCount: 2 },
    { balanceRaw: "2", addressCount: 2 },
    { balanceRaw: "3", addressCount: 2 },
  ]);
});

test("uses cumulative ceil counts over ascending balances and remains monotonic through equal-balance boundaries", () => {
  const result = fixture(["100", "1", "4", "2", "3"]).result;
  assert.deepEqual(result.cumulativeAddressBalanceProfile.map((point) => point.includedAddressCount), [1, 2, 3, 4, 5, 5, 5]);
  assert.deepEqual(result.cumulativeAddressBalanceProfile.map((point) => point.cumulativeObservedBalanceRaw), ["1", "3", "6", "10", "110", "110", "110"]);
  assert.equal(result.cumulativeAddressBalanceProfile.at(-1).cumulativeObservedBalanceRaw, result.observedPositiveBalanceRaw);
  let previousRaw = 0n;
  let previousShare = 0n;
  for (const point of result.cumulativeAddressBalanceProfile) {
    const raw = BigInt(point.cumulativeObservedBalanceRaw);
    const share = BigInt(point.cumulativeObservedBalanceShare.replace(".", ""));
    assert.ok(raw >= previousRaw);
    assert.ok(share >= previousShare);
    previousRaw = raw;
    previousShare = share;
  }
  const ties = fixture(["1", "1", "1", "1", "996"]).result;
  assert.deepEqual(ties.cumulativeAddressBalanceProfile.map((point) => point.cumulativeObservedBalanceRaw), ["1", "2", "3", "4", "1000", "1000", "1000"]);
});

test("uses six-decimal half-up rounding for repeated-address and cumulative-balance shares", () => {
  const repeated = fixture(["1", "1", "1", "2", "3", "4"]).result;
  assert.equal(repeated.addressShareInRepeatedBalanceGroups, "50.000000");
  const halfUp = fixture(["1", "39999999"]).result;
  assert.equal(halfUp.cumulativeAddressBalanceProfile[0].cumulativeObservedBalanceShare, "0.000003");
});

test("represents a successful empty population using the established empty conventions", () => {
  const result = fixture([]).result;
  assert.equal(result.status, "available");
  assert.equal(result.observedPositiveAddressCount, 0);
  assert.equal(result.observedPositiveBalanceRaw, "0");
  assert.equal(result.minimumBalanceRaw, null);
  assert.equal(result.maximumBalanceRaw, null);
  assert.deepEqual(result.quantilesRaw, { p25: null, p50: null, p75: null, p90: null, p99: null });
  assert.equal(result.distinctBalanceCount, 0);
  assert.equal(result.repeatedBalanceGroupCount, 0);
  assert.equal(result.addressesInRepeatedBalanceGroups, 0);
  assert.equal(result.addressShareInRepeatedBalanceGroups, null);
  assert.deepEqual(result.repeatedBalanceGroups, []);
  assert.equal(result.repeatedBalanceGroupsOmitted, 0);
  assert.equal(result.cumulativeAddressBalanceProfile.length, 7);
  assert.ok(result.cumulativeAddressBalanceProfile.every((point) => point.includedAddressCount === 0
    && point.cumulativeObservedBalanceRaw === "0" && point.cumulativeObservedBalanceShare === null));
});

test("excludes zero-balance source rows from positive population metrics", () => {
  const base = fixture(["0", "5", "0", "5"]);
  assert.equal(base.result.sourceHolderRecordCount, 4);
  assert.equal(base.result.observedPositiveAddressCount, 2);
  assert.equal(base.result.observedPositiveBalanceRaw, "10");
  assert.equal(base.result.distinctBalanceCount, 1);
  assert.equal(base.result.addressesInRepeatedBalanceGroups, 2);
});

test("calculates only accepted partial observations while preserving exact GoldRush coverage", () => {
  const partial = fixture(["7", "3"], { mode: "partial", coverage: { status: "partial", reason: "resource_limited" } }).result;
  assert.equal(partial.status, "available");
  assert.deepEqual(partial.sourceCoverage, { status: "partial", reason: "resource_limited" });
  assert.equal(partial.observedPositiveAddressCount, 2);
  assert.equal(partial.observedPositiveBalanceRaw, "10");
  const afterError = fixture(["10"], { mode: "provider_error_after_page", coverage: { status: "partial", reason: "provider_error" } }).result;
  assert.equal(afterError.status, "available");
  assert.deepEqual(afterError.sourceCoverage, { status: "partial", reason: "provider_error" });
  assert.equal(afterError.sourcePagination.pagesRequested, 2);
  assert.equal(afterError.sourcePagination.pagesReturned, 1);
});

test("accepts the Step 2 record-cap case where a final page overflows the record bound", () => {
  const base = fixture(["7", "3"], {
    mode: "record_cap_final_page",
    coverage: { status: "partial", reason: "resource_limited" },
  });
  const atPageBound = {
    ...base.evidence,
    pagination: { ...base.evidence.pagination, maxPages: 1 },
  };
  const result = normalizeEvmAddressBalanceDistribution(atPageBound, base.structure);
  assert.equal(result.status, "available");
  assert.equal(result.sourcePagination.terminalReason, "record_cap");
  assert.equal(result.sourcePagination.providerHasMore, false);
  assert.equal(result.observedPositiveBalanceRaw, "10");
});

test("rejects contradictory partial, unavailable, and malformed pagination semantics", () => {
  const resource = fixture(["7", "3"], {
    mode: "partial",
    coverage: { status: "partial", reason: "resource_limited" },
  });
  const reject = (evidence, structure = resource.structure) => assert.throws(
    () => normalizeEvmAddressBalanceDistribution(evidence, structure),
    /pagination|coverage|page|failure|record count/i,
  );

  // Resource-limited states must identify a cap actually reached. Requests,
  // returned pages, page indexes, and retained-page continuation must agree.
  reject({ ...resource.evidence, pagination: { ...resource.evidence.pagination, terminalReason: "natural_termination" } });
  reject({ ...resource.evidence, pagination: { ...resource.evidence.pagination, pagesRequested: 0 } });
  reject({ ...resource.evidence, pagination: { ...resource.evidence.pagination, pagesReturned: 0 } });
  reject({ ...resource.evidence, pagination: {
    ...resource.evidence.pagination,
    pages: [{ ...resource.evidence.pagination.pages[0], requestedPageNumber: 1 }],
  } });
  reject({ ...resource.evidence, pagination: {
    ...resource.evidence.pagination,
    providerHasMore: false,
    pages: [{ ...resource.evidence.pagination.pages[0], providerHasMore: false }],
  } });
  const pageCap = fixture(["7"], {
    mode: "page_cap",
    coverage: { status: "partial", reason: "resource_limited" },
  });
  reject({ ...pageCap.evidence, pagination: {
    ...pageCap.evidence.pagination,
    maxRecords: 1,
  } }, pageCap.structure);

  // A provider error after a retained page must be the next attempted request,
  // leave the accepted page continuing, and retain the provider-error terminal.
  const afterProviderError = fixture(["9"], {
    mode: "provider_error_after_page",
    coverage: { status: "partial", reason: "provider_error" },
  });
  reject({ ...afterProviderError.evidence, pagination: {
    ...afterProviderError.evidence.pagination,
    terminalReason: "natural_termination",
  } }, afterProviderError.structure);
  reject({ ...afterProviderError.evidence, failure: {
    category: "malformed_response", httpStatus: null, message: "Malformed.",
  } }, afterProviderError.structure);
  reject({ ...afterProviderError.evidence, pagination: {
    ...afterProviderError.evidence.pagination,
    pagesRequested: 1,
  } }, afterProviderError.structure);
  reject({ ...afterProviderError.evidence, pagination: {
    ...afterProviderError.evidence.pagination,
    pages: [{ ...afterProviderError.evidence.pagination.pages[0], providerHasMore: false }],
  } }, afterProviderError.structure);

  // Malformed-response after an accepted page remains valid only with its own
  // terminal/failure category and consistent returned-page count.
  const afterMalformed = fixture(["9"], {
    mode: "malformed_after_page",
    coverage: { status: "partial", reason: "malformed_response" },
  });
  assert.equal(afterMalformed.result.status, "available");
  reject({ ...afterMalformed.evidence, pagination: {
    ...afterMalformed.evidence.pagination,
    terminalReason: "provider_error",
  } }, afterMalformed.structure);
  reject({ ...afterMalformed.evidence, failure: {
    category: "http", httpStatus: 503, message: "Provider error.",
  } }, afterMalformed.structure);
  reject({ ...afterMalformed.evidence, pagination: {
    ...afterMalformed.evidence.pagination,
    pagesRequested: 1,
  } }, afterMalformed.structure);
  reject({ ...afterMalformed.evidence, pagination: {
    ...afterMalformed.evidence.pagination,
    pagesReturned: 0,
  } }, afterMalformed.structure);

  for (const [mode, coverage] of [
    ["unavailable", { status: "unavailable", reason: "provider_error" }],
    ["malformed", { status: "malformed", reason: "malformed_response" }],
  ]) {
    const empty = fixture([], { mode, coverage });
    reject({ ...empty.evidence, pagination: {
      ...empty.evidence.pagination,
      terminalReason: "record_cap",
    } }, empty.structure);
    reject({ ...empty.evidence, pagination: {
      ...empty.evidence.pagination,
      providerHasMore: true,
    } }, empty.structure);
  }
});

test("unavailable or malformed evidence with no accepted holder rows stays unavailable, not empty", () => {
  for (const [mode, coverage] of [
    ["unavailable", { status: "unavailable", reason: "provider_error" }],
    ["malformed", { status: "malformed", reason: "malformed_response" }],
  ]) {
    const result = fixture([], { mode, coverage }).result;
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "no_accepted_holder_observations");
    assert.deepEqual(result.sourceCoverage, coverage);
    assert.equal(result.sourceHolderRecordCount, 0);
    assert.equal("observedPositiveBalanceRaw" in result, false);
  }
  const noRowsAfterPartialError = fixture([], {
    mode: "provider_error_after_page",
    coverage: { status: "partial", reason: "provider_error" },
  }).result;
  assert.equal(noRowsAfterPartialError.status, "unavailable");
  assert.deepEqual(noRowsAfterPartialError.sourceCoverage, { status: "partial", reason: "provider_error" });
});

test("rejects mismatched chain, contract, coverage, counts, or positive-balance observations", () => {
  const base = fixture(["25"]);
  assert.throws(() => normalizeEvmAddressBalanceDistribution({ ...base.evidence, chain: "ethereum" }, base.structure), /provenance|identity/);
  assert.throws(() => normalizeEvmAddressBalanceDistribution({ ...base.evidence, tokenContractAddress: address(9) }, base.structure), /identity/);
  assert.throws(() => normalizeEvmAddressBalanceDistribution(base.evidence, { ...base.structure, goldRushCoverage: { status: "partial", reason: "provider_error" } }), /coverage do not match/);
  assert.throws(() => normalizeEvmAddressBalanceDistribution(base.evidence, { ...base.structure, observedPositiveBalanceRaw: "24" }), /total does not match/);
  assert.throws(() => normalizeEvmAddressBalanceDistribution(base.evidence, {
    ...base.structure,
    rankedBalanceBearingAddresses: [{ address: address(9), balanceRaw: "25" }],
  }), /ranked positive address evidence is inconsistent/);
});

test("rejects malformed evidence boundaries and contradictory provider-complete claims", () => {
  const base = fixture(["25"]);
  assert.throws(() => normalizeEvmAddressBalanceDistribution(null, base.structure), /inputs are malformed/);
  assert.throws(() => normalizeEvmAddressBalanceDistribution(base.evidence, null), /inputs are malformed/);
  assert.throws(() => normalizeEvmAddressBalanceDistribution({
    ...base.evidence,
    holders: [{ address: address(1), rawBalance: (1n << 256n).toString() }],
  }, base.structure), /raw balance is malformed/);
  assert.throws(() => normalizeEvmAddressBalanceDistribution({
    ...base.evidence,
    pagination: { ...base.evidence.pagination, terminalReason: "record_cap", providerHasMore: true },
  }, base.structure), /pagination|provider-complete coverage contradicts/);
});
