const assert = require("node:assert/strict");
const { test } = require("node:test");
const { selectSolanaHistoricalAuthorities, selectSolanaHistoricalAuthoritiesV2 } = require("../dist/normalization/solanaHistoricalAuthoritySelector.js");
const { createSolanaHolderSnapshotRecordV2 } = require("../dist/normalization/solanaHolderSnapshotComparison.js");
const { normalizeSolanaHolderStructure } = require("../dist/normalization/solanaHolders.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const MINT = key(42);

function holderStructure(balances, overrides = {}) {
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
    ...overrides,
  };
}

function selectedRanks(balances, cap) {
  return selectSolanaHistoricalAuthorities(holderStructure(balances), cap).selectedAuthorities.map((entry) => entry.sourceRank);
}

function snapshotRecordV2(balances, { partial = false, amountPartial = false } = {}) {
  const tokenProgram = amountPartial ? "token-2022" : "spl-token";
  const accounts = balances.map((balance, index) => {
    const data = Buffer.alloc(165);
    data.set(Buffer.alloc(32, 42), 0);
    data.set(Buffer.alloc(32, index + 1), 32);
    data.writeBigUInt64LE(BigInt(balance), 64);
    data[108] = 1;
    return {
      address: key(index + 100), programOwner: SOLANA_TOKEN_PROGRAM_IDS[tokenProgram],
      dataBase64: data.toString("base64"), reportedSpace: data.length,
    };
  });
  const holder = normalizeSolanaHolderStructure({
    mintAddress: MINT, tokenProgram, decimals: 6,
    currentMintSupplyRaw: String(balances.reduce((sum, value) => sum + BigInt(value), 100n)),
    mintExtensionTypes: amountPartial ? [4] : [], fetchedAt: "2026-10-01T12:00:00.000Z",
    ...(partial
      ? { acquisition: { status: "available", completeness: "partial", stopReason: "request_timeout", configuredMaxPages: 20, requestedPageSize: 5000, pages: [{ accounts, paginationKey: "2", contextSlot: 100 }] } }
      : { pages: [{ accounts, paginationKey: null, contextSlot: 100 }] }),
  });
  return partial
    ? createSolanaHolderSnapshotRecordV2(holder)
    : createSolanaHolderSnapshotRecordV2(holder, { completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20, requestedPageSize: 5000 });
}

test("validates the configured cap as a positive safe integer", () => {
  const snapshot = holderStructure([]);
  for (const cap of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.throws(() => selectSolanaHistoricalAuthorities(snapshot, cap), /positive safe integer/);
  }
  assert.equal(selectSolanaHistoricalAuthorities(snapshot, 1).selectedAuthorityCount, 0);
});

test("handles zero and one candidate", () => {
  assert.deepEqual(selectSolanaHistoricalAuthorities(holderStructure([]), 4).selectedAuthorities, []);
  const one = selectSolanaHistoricalAuthorities(holderStructure([9]), 4);
  assert.equal(one.candidateAuthorityCount, 1);
  assert.equal(one.selectedAuthorityCount, 1);
  assert.deepEqual(one.selectedAuthorities.map((entry) => entry.sourceRank), [0]);
});

test("selects every candidate when the candidate count is below or equal to the cap", () => {
  assert.deepEqual(selectedRanks([1, 3, 2], 4), [0, 1, 2]);
  assert.deepEqual(selectedRanks([1, 3, 2], 3), [0, 1, 2]);
});

test("selects exactly the cap with endpoints and nearest evenly spaced ranks", () => {
  assert.deepEqual(selectedRanks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [0, 3, 6, 9]);
  assert.deepEqual(selectedRanks([1, 2, 3, 4, 5, 6, 7, 8], 5), [0, 2, 4, 5, 7]);
  assert.deepEqual(selectedRanks([1, 2, 3, 4, 5, 6], 3), [0, 3, 5]);
});

test("cap one selects source rank zero", () => {
  assert.deepEqual(selectedRanks([1, 2, 3, 4], 1), [0]);
});

test("exact half-way ideal rank rounds upward", () => {
  // For n=6 and k=3, the middle ideal rank is 2.5, which rounds to 3.
  assert.deepEqual(selectedRanks([1, 2, 3, 4, 5, 6], 3), [0, 3, 5]);
});

test("normalizes independently of candidate input order", () => {
  const original = holderStructure([2, 100, 4, 8, 16, 32, 64]);
  const permuted = structuredClone(original);
  permuted.rawOwnerAuthorities.reverse();
  assert.deepEqual(
    selectSolanaHistoricalAuthorities(original, 4),
    selectSolanaHistoricalAuthorities(permuted, 4),
  );
});

test("breaks equal-balance ties by lexicographically ascending authority address", () => {
  const snapshot = holderStructure([7, 7, 7]);
  const expected = [...snapshot.rawOwnerAuthorities].sort((a, b) => a.ownerAddress < b.ownerAddress ? -1 : a.ownerAddress > b.ownerAddress ? 1 : 0);
  const result = selectSolanaHistoricalAuthorities(snapshot, 3);
  assert.deepEqual(result.selectedAuthorities.map((entry) => entry.authorityAddress), expected.map((entry) => entry.ownerAddress));
});

test("sorts very large balances exactly without Number conversion", () => {
  const snapshot = holderStructure(["9007199254740992", "9007199254740993", "18446744073709551615"]);
  const result = selectSolanaHistoricalAuthorities(snapshot, 3);
  assert.deepEqual(result.selectedAuthorities.map((entry) => entry.balanceRaw), [
    "18446744073709551615", "9007199254740993", "9007199254740992",
  ]);
});

test("rejects zero, malformed, and negative raw balances", () => {
  for (const balanceRaw of ["0", "", "-1", "1.5", "01", " 1"]) {
    const snapshot = holderStructure([1]);
    snapshot.rawOwnerAuthorities[0].balanceRaw = balanceRaw;
    assert.throws(() => selectSolanaHistoricalAuthorities(snapshot, 1), /canonical positive raw integer string/);
  }
});

test("rejects duplicate and malformed owner addresses and inconsistent candidate counts", () => {
  const duplicate = holderStructure([1, 2]);
  duplicate.rawOwnerAuthorities[1].ownerAddress = duplicate.rawOwnerAuthorities[0].ownerAddress;
  assert.throws(() => selectSolanaHistoricalAuthorities(duplicate, 1), /duplicate owner-authority/);

  const malformed = holderStructure([1]);
  malformed.rawOwnerAuthorities[0].ownerAddress = "not-a-public-key";
  assert.throws(() => selectSolanaHistoricalAuthorities(malformed, 1), /malformed owner-authority/);

  const countMismatch = holderStructure([1]);
  countMismatch.rawOwnerCount = 2;
  assert.throws(() => selectSolanaHistoricalAuthorities(countMismatch, 1), /count does not match/);
});

test("returns distinct increasing source ranks and respects selection-count invariants", () => {
  for (const [candidateCount, cap] of [[0, 1], [1, 5], [5, 5], [19, 7], [100, 1]]) {
    const result = selectSolanaHistoricalAuthorities(holderStructure(Array.from({ length: candidateCount }, (_, i) => i + 1)), cap);
    const ranks = result.selectedAuthorities.map((entry) => entry.sourceRank);
    assert.equal(result.selectedAuthorityCount, Math.min(candidateCount, cap));
    assert.ok(result.selectedAuthorityCount <= cap);
    assert.equal(new Set(result.selectedAuthorities.map((entry) => entry.authorityAddress)).size, result.selectedAuthorityCount);
    assert.equal(new Set(ranks).size, ranks.length);
    assert.ok(ranks.every((rank, index) => index === 0 || ranks[index - 1] < rank));
    if (candidateCount > cap && cap > 1) assert.deepEqual([ranks[0], ranks.at(-1)], [0, candidateCount - 1]);
  }
});

test("rank coverage remains deterministic for concentrated and all-equal balances", () => {
  assert.deepEqual(selectedRanks(["1000000000000", 1, 1, 1, 1, 1, 1, 1], 4), [0, 2, 5, 7]);
  assert.deepEqual(selectedRanks([9, 9, 9, 9, 9, 9, 9, 9], 4), [0, 2, 5, 7]);
});

test("preserves source coverage and snapshot limitations in selection provenance", () => {
  const snapshot = holderStructure([4, 1, 3], {
    amountCoverage: { state: "partial", unsupportedExtensionTypes: [4, 24], reason: "unsupported_balance_affecting_extension" },
  });
  const result = selectSolanaHistoricalAuthorities(snapshot, 2);
  assert.equal(result.selectorVersion, "solana-rank-coverage-v1");
  assert.equal(result.selectionBasis, "balance_descending_evenly_spaced_ranks_nearest_half_up");
  assert.equal(result.mintAddress, snapshot.mintAddress);
  assert.equal(result.sourceHolderSnapshotFetchedAt, snapshot.fetchedAt);
  assert.equal(result.candidateAuthorityCount, 3);
  assert.equal(result.selectedAuthorityCount, 2);
  assert.equal(result.configuredMaximumSelectedAuthorityCount, 2);
  assert.deepEqual(result.sourceCoverage, {
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [100, 101] },
    amountCoverage: { state: "partial", reason: "unsupported_balance_affecting_extension", unsupportedExtensionTypes: [4, 24] },
  });
  assert.ok(result.selectedAuthorities.every((entry) => entry.selectionReason === "rank_position"));
});

test("does not mutate the source holder structure", () => {
  const snapshot = holderStructure([2, 100, 4, 8]);
  const before = structuredClone(snapshot);
  selectSolanaHistoricalAuthorities(snapshot, 2);
  assert.deepEqual(snapshot, before);
});

test("V2 complete selection is methodologically equivalent to V1", () => {
  const record = snapshotRecordV2([4, 100, 8, 32, 16, 64]);
  const v1Structure = { ...record.snapshot, enumeration: { ...record.snapshot.enumeration, completeness: "complete" } };
  const v1 = selectSolanaHistoricalAuthorities(v1Structure, 4);
  const v2 = selectSolanaHistoricalAuthoritiesV2(record, 4);
  assert.equal(v2.selectorVersion, "solana-rank-coverage-v2");
  assert.equal(v2.sourceHolder.candidateFrameCompleteness, "complete");
  assert.deepEqual(v2.selectedAuthorities.map(({ authorityAddress, balanceRaw, observedCandidateFrameRank, selectionPosition, selectionReason }) => ({
    authorityAddress, balanceRaw, sourceRank: observedCandidateFrameRank, selectionPosition, selectionReason,
  })), v1.selectedAuthorities);
});

test("V2 accepts partial immutable snapshots and labels ranks within the observed candidate frame", () => {
  const record = snapshotRecordV2([7, 100, 7, 25, 50], { partial: true });
  const before = structuredClone(record);
  const result = selectSolanaHistoricalAuthoritiesV2(record, 3);
  assert.equal(result.sourceHolder.candidateFrameCompleteness, "partial");
  assert.equal(result.sourceHolder.enumeration.completeness, "partial");
  assert.equal(result.sourceHolder.acquisition.stopReason, "request_timeout");
  assert.equal(result.sourceHolder.candidateAuthorityCount, 5);
  assert.equal(result.configuredMaximumSelectedAuthorityCount, 3);
  assert.deepEqual(result.selectedAuthorities.map((item) => item.observedCandidateFrameRank), [0, 2, 4]);
  assert.deepEqual(result.selectedAuthorities.map((item) => item.selectionPosition), [0, 1, 2]);
  assert.ok(result.selectedAuthorities.every((item) => Object.hasOwn(item, "observedCandidateFrameRank") && !Object.hasOwn(item, "sourceRank")));
  assert.equal(JSON.stringify(result).includes("global"), false);
  assert.deepEqual(record, before);
});

test("V2 candidate frame is partial when amount coverage is partial even if enumeration completed", () => {
  const record = snapshotRecordV2([10, 9], { amountPartial: true });
  assert.equal(record.snapshot.enumeration.completeness, "complete");
  assert.equal(record.snapshot.amountCoverage.state, "partial");
  assert.equal(selectSolanaHistoricalAuthoritiesV2(record, 2).sourceHolder.candidateFrameCompleteness, "partial");
});

test("V2 selector rejects invalid snapshot IDs before ranking", () => {
  const record = snapshotRecordV2([1]);
  const tampered = { ...record, snapshotId: `sha256:${"0".repeat(64)}` };
  assert.throws(() => selectSolanaHistoricalAuthoritiesV2(tampered, 1), /snapshot ID/);
});

test("V2 selector rejects duplicate candidate rows through the snapshot validator", () => {
  const record = structuredClone(snapshotRecordV2([3, 2]));
  record.snapshot.rawOwnerAuthorities[1].ownerAddress = record.snapshot.rawOwnerAuthorities[0].ownerAddress;
  assert.throws(() => selectSolanaHistoricalAuthoritiesV2(record, 1), /duplicate owner authority/);
});
