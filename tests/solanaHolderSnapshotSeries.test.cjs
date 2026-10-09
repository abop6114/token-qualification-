const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  buildSolanaHolderSnapshotSeriesEvidence,
  buildSolanaHolderSnapshotSeriesEvidenceV2,
} = require("../dist/normalization/solanaHolderSnapshotSeries.js");
const {
  calculateSolanaHolderSnapshotId,
  createSolanaHolderSnapshotRecord,
  createSolanaHolderSnapshotRecordV2,
} = require("../dist/normalization/solanaHolderSnapshotComparison.js");
const { normalizeSolanaHolderStructure } = require("../dist/normalization/solanaHolders.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { decodeSolanaPublicKey, encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const MINT = "11111111111111111111111111111111";
const SOURCE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

function account(ownerByte, amount, accountByte = ownerByte + 64, tokenProgram = "spl-token") {
  const data = Buffer.alloc(165);
  data.set(decodeSolanaPublicKey(MINT), 0);
  data.set(Buffer.alloc(32, ownerByte), 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  data[108] = 1;
  return {
    address: encodeSolanaPublicKey(Buffer.alloc(32, accountByte)),
    programOwner: SOLANA_TOKEN_PROGRAM_IDS[tokenProgram],
    dataBase64: data.toString("base64"),
    reportedSpace: data.length,
  };
}

function snapshot(balances, index, options = {}) {
  const pageSlots = options.contextSlots ?? [100 + index];
  const holder = normalizeSolanaHolderStructure({
    mintAddress: MINT,
    tokenProgram: options.tokenProgram ?? "spl-token",
    decimals: options.decimals ?? 6,
    currentMintSupplyRaw: options.supply ?? "1000",
    mintExtensionTypes: options.mintExtensionTypes ?? [],
    pages: [{
      accounts: balances.map(([ownerByte, amount], accountIndex) => account(ownerByte, amount, ownerByte + 64 + accountIndex, options.tokenProgram ?? "spl-token")),
      paginationKey: null,
      contextSlot: pageSlots[0],
    }],
    fetchedAt: new Date(SOURCE_TIME + index * 60_000).toISOString(),
  });
  if (options.contextSlots) {
    holder.enumeration.pageCount = options.contextSlots.length;
    holder.enumeration.contextSlots = [...options.contextSlots];
  }
  if (options.partialCoverageWithAvailableConcentration) {
    holder.amountCoverage = {
      state: "partial",
      unsupportedExtensionTypes: [1],
      reason: "unsupported_balance_affecting_extension",
    };
  }
  if (options.mintAddress) holder.mintAddress = options.mintAddress;
  return createSolanaHolderSnapshotRecord(holder);
}

function snapshotV2(balances, index, options = {}) {
  const holderOptions = {
    tokenProgram: options.tokenProgram ?? "spl-token",
    decimals: options.decimals ?? 6,
    supply: options.supply ?? "1000",
  };
  const accounts = balances.map(([ownerByte, amount], accountIndex) => account(ownerByte, amount, ownerByte + 64 + accountIndex, holderOptions.tokenProgram));
  const fetchedAt = new Date(SOURCE_TIME + index * 60_000).toISOString();
  if (options.partial) {
    const pageCount = options.stopReason === "page_cap" ? 20 : 1;
    const base58CursorSuffixes = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const pages = Array.from({ length: pageCount }, (_, pageIndex) => ({
      accounts: pageIndex === 0 ? accounts : [],
      paginationKey: `cursor${base58CursorSuffixes[pageIndex]}`,
      contextSlot: 100 + index * 20 + pageIndex,
    }));
    const holder = normalizeSolanaHolderStructure({
      mintAddress: MINT,
      tokenProgram: holderOptions.tokenProgram,
      decimals: holderOptions.decimals,
      currentMintSupplyRaw: holderOptions.supply,
      mintExtensionTypes: options.mintExtensionTypes ?? [],
      acquisition: {
        status: "available", completeness: "partial", stopReason: options.stopReason ?? "request_timeout",
        configuredMaxPages: 20, requestedPageSize: 5000, pages,
      },
      fetchedAt,
    });
    return createSolanaHolderSnapshotRecordV2(holder);
  }
  const holder = normalizeSolanaHolderStructure({
    mintAddress: MINT,
    tokenProgram: holderOptions.tokenProgram,
    decimals: holderOptions.decimals,
    currentMintSupplyRaw: holderOptions.supply,
    mintExtensionTypes: options.mintExtensionTypes ?? [],
    pages: [{ accounts, paginationKey: null, contextSlot: 100 + index }],
    fetchedAt,
  });
  return createSolanaHolderSnapshotRecordV2(holder, {
    completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20, requestedPageSize: 5000,
  });
}

function series(...captures) {
  return { schemaVersion: "solana-holder-snapshot-series-v1", captures };
}

function evidence(...captures) {
  return buildSolanaHolderSnapshotSeriesEvidence(series(...captures));
}

function authority(result, ownerByte) {
  const address = encodeSolanaPublicKey(Buffer.alloc(32, ownerByte));
  return result.authorities.find((item) => item.authorityAddress === address);
}

test("builds a two-capture series with ordered references and exact elapsed span", () => {
  const first = snapshot([[1, "20"]], 0);
  const second = snapshot([[1, "25"]], 2, { supply: "1200" });
  const result = evidence(first, second);
  assert.equal(result.schemaVersion, "solana-holder-snapshot-series-evidence-v1");
  assert.equal(result.captures.length, 2);
  assert.deepEqual(result.captures.map((capture) => capture.snapshotId), [first.snapshotId, second.snapshotId]);
  assert.equal(result.elapsedCaptureSpanMilliseconds, 120_000);
  assert.deepEqual(result.adjacentObservedPositiveOwnerCountDeltas, [{ status: "available", value: 0, completeness: "complete" }]);
});

test("preserves every capture and creates adjacent deltas for three or more captures", () => {
  const result = evidence(snapshot([[1, "20"]], 0), snapshot([[1, "25"]], 1), snapshot([[1, "30"]], 2));
  assert.equal(result.captures.length, 3);
  assert.equal(result.observedPositiveOwnerCountTrajectory.length, 3);
  assert.equal(result.adjacentObservedPositiveOwnerCountDeltas.length, 2);
  assert.deepEqual(result.adjacentObservedPositiveOwnerCountDeltas.map((metric) => metric.value), [0, 0]);
});

test("rejects fewer than two captures, invalid records, and tampered IDs", () => {
  assert.throws(() => buildSolanaHolderSnapshotSeriesEvidence(series(snapshot([[1, "20"]], 0))), /at least two/);
  const tampered = { ...snapshot([[1, "20"]], 0), snapshotId: `sha256:${"0".repeat(64)}` };
  assert.throws(() => evidence(tampered, snapshot([[1, "20"]], 1)), /snapshot ID/);
});

test("rejects duplicate IDs and does not sort captures supplied out of timestamp order", () => {
  const first = snapshot([[1, "20"]], 0);
  assert.throws(() => evidence(first, first), /duplicate snapshot ID/);
  const later = snapshot([[1, "20"]], 2);
  const earlier = snapshot([[1, "20"]], 1);
  assert.throws(() => evidence(later, earlier), /strictly increasing caller-provided/);
  const equalTime = { ...later, snapshot: { ...later.snapshot, fetchedAt: first.snapshot.fetchedAt } };
  equalTime.snapshotId = calculateSolanaHolderSnapshotId(equalTime.snapshot, equalTime.source);
  assert.throws(() => evidence(first, equalTime), /strictly increasing caller-provided/);
});

test("rejects incompatible mint, token program, and decimals", () => {
  const first = snapshot([[1, "20"]], 0);
  const otherMintHolder = normalizeSolanaHolderStructure({
    mintAddress: encodeSolanaPublicKey(Buffer.alloc(32, 7)), tokenProgram: "spl-token", decimals: 6,
    currentMintSupplyRaw: "1000", mintExtensionTypes: [],
    pages: [{ accounts: [], paginationKey: null, contextSlot: 101 }],
    fetchedAt: new Date(SOURCE_TIME + 60_000).toISOString(),
  });
  const otherMint = createSolanaHolderSnapshotRecord(otherMintHolder);
  assert.throws(() => evidence(first, otherMint), /mint mismatch/);

  for (const mutate of [
    (holder) => { holder.tokenProgram = "token-2022"; },
    (holder) => { holder.decimals = 7; },
  ]) {
    const holder = normalizeSolanaHolderStructure({
      mintAddress: MINT, tokenProgram: "spl-token", decimals: 6, currentMintSupplyRaw: "1000",
      mintExtensionTypes: [], pages: [{ accounts: [account(1, "20")], paginationKey: null, contextSlot: 102 }],
      fetchedAt: new Date(SOURCE_TIME + 60_000).toISOString(),
    });
    mutate(holder);
    assert.throws(() => evidence(first, createSolanaHolderSnapshotRecord(holder)), /mismatch/);
  }
});

test("positiveAtEveryCapture is yes only when all recorded states are positive", () => {
  const result = evidence(snapshot([[1, "20"]], 0), snapshot([[1, "25"]], 1), snapshot([[1, "30"]], 2));
  assert.equal(authority(result, 1).positiveAtEveryCapture, "yes");
  assert.equal(authority(result, 1).positiveObservedCaptureCount, 3);
  assert.equal(authority(result, 1).provenNotPositiveCaptureCount, 0);
  assert.equal(authority(result, 1).unknownCaptureCount, 0);
});

test("one proven non-positive capture makes positiveAtEveryCapture no", () => {
  const result = evidence(snapshot([[1, "20"]], 0), snapshot([], 1), snapshot([[1, "30"]], 2));
  const item = authority(result, 1);
  assert.equal(item.captures[1].state.status, "not_positive");
  assert.equal(item.positiveAtEveryCapture, "no");
  assert.equal(item.positiveAtBothEndpoints, "yes");
});

test("partial amount coverage leaves absent middle-capture state unknown but preserves positive endpoints", () => {
  const result = evidence(
    snapshot([[1, "20"]], 0),
    snapshot([[2, "15"]], 1, { mintExtensionTypes: [1] }),
    snapshot([[1, "30"]], 2),
  );
  const item = authority(result, 1);
  assert.equal(item.captures[1].state.status, "unknown");
  assert.equal(item.captures[1].state.reason, "amount_coverage_partial");
  assert.equal(item.positiveAtEveryCapture, "unknown");
  assert.equal(item.positiveAtBothEndpoints, "yes");
  assert.deepEqual(item.captures.map((capture) => capture.state.status), ["positive_observed", "unknown", "positive_observed"]);
});

test("endpoint predicate is unknown when an endpoint absence cannot be proven", () => {
  const result = evidence(snapshot([[1, "20"]], 0, { mintExtensionTypes: [1] }), snapshot([[2, "25"]], 1));
  const item = authority(result, 2);
  assert.equal(item.captures[0].state.status, "unknown");
  assert.equal(item.positiveAtBothEndpoints, "unknown");
});

test("supply inconsistency makes absent authorities unknown across the series", () => {
  const result = evidence(snapshot([[1, "1200"]], 0, { supply: "1000" }), snapshot([[2, "25"]], 1));
  const item = authority(result, 2);
  assert.equal(item.captures[0].state.status, "unknown");
  assert.equal(item.captures[0].state.reason, "supply_inconsistency");
  assert.equal(item.positiveAtBothEndpoints, "unknown");
});

test("zero supply alone permits proven non-positive absence while concentration remains unavailable", () => {
  const result = evidence(snapshot([], 0, { supply: "0" }), snapshot([[1, "20"]], 1));
  const item = authority(result, 1);
  assert.deepEqual(item.captures[0].state, { status: "not_positive", balanceRaw: "0", basis: "complete_positive_owner_set" });
  assert.equal(result.concentrationTrajectory[0].top1.status, "unavailable");
  assert.equal(result.concentrationTrajectory[0].top1.reason, "zero_supply");
});

test("owner-count trajectory preserves values and marks partial amount coverage", () => {
  const result = evidence(snapshot([[1, "20"]], 0), snapshot([[1, "25"]], 1, { mintExtensionTypes: [1] }));
  assert.deepEqual(result.observedPositiveOwnerCountTrajectory, [
    { status: "available", value: 1, completeness: "complete" },
    { status: "available", value: 1, completeness: "partial" },
  ]);
  assert.deepEqual(result.adjacentObservedPositiveOwnerCountDeltas, [{ status: "available", value: 0, completeness: "partial" }]);
});

test("concentration trajectory preserves available values and completeness", () => {
  const result = evidence(snapshot([[1, "250"]], 0), snapshot([[1, "300"]], 1));
  assert.deepEqual(result.concentrationTrajectory[0].top1, { status: "available", percentage: "25.000000", completeness: "complete" });
  assert.deepEqual(result.concentrationTrajectory[1].top1, { status: "available", percentage: "30.000000", completeness: "complete" });
});

test("partial amount coverage preserves an available concentration as partial", () => {
  const result = evidence(
    snapshot([[1, "250"]], 0, { tokenProgram: "token-2022", partialCoverageWithAvailableConcentration: true }),
    snapshot([[1, "300"]], 1, { tokenProgram: "token-2022" }),
  );
  assert.deepEqual(result.concentrationTrajectory[0].top1, {
    status: "available",
    percentage: "25.000000",
    completeness: "partial",
  });
});

test("rejects unavailable concentration with contradictory partial-coverage metadata", () => {
  const malformed = normalizeSolanaHolderStructure({
    mintAddress: MINT,
    tokenProgram: "token-2022",
    decimals: 6,
    currentMintSupplyRaw: "1000",
    mintExtensionTypes: [1],
    pages: [{ accounts: [account(1, "250", 65, "token-2022")], paginationKey: null, contextSlot: 100 }],
    fetchedAt: new Date(SOURCE_TIME).toISOString(),
  });
  malformed.amountCoverage.unsupportedExtensionTypes = [];
  assert.throws(() => createSolanaHolderSnapshotRecord(malformed), /unsupported-extension reason has no extension evidence/);
});

test("unavailable concentration reason is preserved for zero-supply captures", () => {
  const result = evidence(snapshot([], 0, { supply: "0" }), snapshot([[1, "20"]], 1));
  assert.deepEqual(result.concentrationTrajectory[0].top5, { status: "unavailable", percentage: null, reason: "zero_supply" });
});

test("preserves differing page counts and ordered context slots without a canonical slot", () => {
  const first = snapshot([[1, "20"]], 0, { contextSlots: [100, 101] });
  const second = snapshot([[1, "25"]], 1, { contextSlots: [200] });
  const result = evidence(first, second);
  assert.deepEqual(result.captures.map((capture) => capture.pageCount), [2, 1]);
  assert.deepEqual(result.captures.map((capture) => capture.contextSlots), [[100, 101], [200]]);
  assert.equal(Object.hasOwn(result, "canonicalSlot"), false);
});

test("authority union is lexicographically ordered and inputs remain unchanged", () => {
  const first = snapshot([[3, "40"], [1, "20"]], 0);
  const second = snapshot([[2, "30"]], 1);
  const before = structuredClone(series(first, second));
  const result = buildSolanaHolderSnapshotSeriesEvidence(series(first, second));
  const addresses = result.authorities.map((item) => item.authorityAddress);
  assert.deepEqual(addresses, [...addresses].sort());
  assert.deepEqual(series(first, second), before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.authorities), true);
});

function seriesV2(...captures) {
  return { schemaVersion: "solana-holder-snapshot-series-v2", captures };
}

test("V2 series handles V1/V2 captures and records legacy provenance as not recorded", () => {
  const legacy = snapshot([[1, "20"]], 0);
  const current = snapshotV2([[1, "25"]], 1);
  const result = buildSolanaHolderSnapshotSeriesEvidenceV2(seriesV2(legacy, current));
  assert.equal(result.schemaVersion, "solana-holder-snapshot-series-evidence-v2");
  assert.deepEqual(result.captures[0].record, {
    schemaVersion: "solana-holder-snapshot-record-v1", acquisition: { status: "not_recorded", reason: "legacy_v1_schema" },
  });
  assert.equal(result.captures[1].record.acquisition.stopReason, "provider_terminated");
  assert.equal(authority(result, 1).positiveAtEveryCapture, "yes");
});

test("partial middle V2 capture leaves missing authority unknown between complete endpoints", () => {
  const first = snapshotV2([[1, "20"]], 0);
  const middle = snapshotV2([[2, "10"]], 1, { partial: true, stopReason: "provider_error" });
  const last = snapshotV2([[1, "30"]], 2);
  const result = buildSolanaHolderSnapshotSeriesEvidenceV2(seriesV2(first, middle, last));
  const item = authority(result, 1);
  assert.deepEqual(item.captures.map((capture) => capture.state.status), ["positive_observed", "unknown", "positive_observed"]);
  assert.equal(item.positiveAtEveryCapture, "unknown");
  assert.equal(item.positiveAtBothEndpoints, "yes");
  assert.equal(result.observedPositiveOwnerCountTrajectory[1].completeness, "partial");
  assert.equal(result.adjacentObservedPositiveOwnerCountDeltas[0].completeness, "partial");
  assert.equal(result.captures[1].record.acquisition.stopReason, "provider_error");
});

test("V2 partial capture preserves positive observations and explicit unknown concentration", () => {
  const partial = snapshotV2([[1, "250"]], 0, { partial: true });
  const full = snapshotV2([[1, "300"]], 1);
  const result = buildSolanaHolderSnapshotSeriesEvidenceV2(seriesV2(partial, full));
  assert.deepEqual(authority(result, 1).captures[0].state, { status: "positive_observed", balanceRaw: "250" });
  assert.deepEqual(result.concentrationTrajectory[0].top1, { status: "unavailable", percentage: null, reason: "enumeration_incomplete" });
});

test("V2 records preserve every approved partial acquisition stop reason", () => {
  for (const stopReason of ["page_cap", "request_timeout", "provider_error", "malformed_response"]) {
    const partial = snapshotV2([[1, "20"]], 0, { partial: true, stopReason });
    const complete = snapshotV2([[1, "25"]], 1);
    const result = buildSolanaHolderSnapshotSeriesEvidenceV2(seriesV2(partial, complete));
    assert.equal(result.captures[0].record.acquisition.stopReason, stopReason);
    assert.equal(result.captures[0].pageCount, stopReason === "page_cap" ? 20 : 1);
  }
});

test("V2 series preserves accepted page slots and does not expose cursors or mutate records", () => {
  const partial = snapshotV2([[1, "20"]], 0, { partial: true, stopReason: "page_cap" });
  const complete = snapshotV2([[1, "25"]], 1);
  const before = structuredClone([partial, complete]);
  const result = buildSolanaHolderSnapshotSeriesEvidenceV2(seriesV2(partial, complete));
  assert.equal(result.captures[0].pageCount, 20);
  assert.deepEqual(result.captures[0].contextSlots, Array.from({ length: 20 }, (_, i) => 100 + i));
  assert.equal(JSON.stringify(result).includes("cursor"), false);
  assert.deepEqual([partial, complete], before);
});

test("V2 series rejects malformed versioned captures and incompatible identity", () => {
  const first = snapshotV2([[1, "20"]], 0);
  const second = snapshotV2([[1, "25"]], 1, { partial: true });
  assert.throws(() => buildSolanaHolderSnapshotSeriesEvidenceV2(seriesV2(first)), /at least two/);
  assert.throws(() => buildSolanaHolderSnapshotSeriesEvidenceV2(seriesV2(first, { ...second, snapshotId: `sha256:${"0".repeat(64)}` })), /snapshot ID/);
  const otherMintHolder = normalizeSolanaHolderStructure({
    mintAddress: encodeSolanaPublicKey(Buffer.alloc(32, 7)), tokenProgram: "spl-token", decimals: 6,
    currentMintSupplyRaw: "1000", mintExtensionTypes: [],
    pages: [{ accounts: [], paginationKey: null, contextSlot: 101 }],
    fetchedAt: new Date(SOURCE_TIME + 60_000).toISOString(),
  });
  const otherMint = createSolanaHolderSnapshotRecordV2(otherMintHolder, {
    completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20, requestedPageSize: 5000,
  });
  assert.throws(() => buildSolanaHolderSnapshotSeriesEvidenceV2(seriesV2(first, otherMint)), /mint mismatch/);
});

