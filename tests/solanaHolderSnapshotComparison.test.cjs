const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  calculateSolanaHolderSnapshotId,
  compareSolanaHolderSnapshots,
  createSolanaHolderSnapshotRecord,
} = require("../dist/normalization/solanaHolderSnapshotComparison.js");
const { normalizeSolanaHolderStructure } = require("../dist/normalization/solanaHolders.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { decodeSolanaPublicKey, encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const MINT = "11111111111111111111111111111111";
const SUPPLY = "1000";
function account(ownerByte, amount, accountByte = ownerByte + 64) {
  const data = Buffer.alloc(165);
  data.set(decodeSolanaPublicKey(MINT), 0);
  data.set(Buffer.alloc(32, ownerByte), 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  data[108] = 1;
  return {
    address: encodeSolanaPublicKey(Buffer.alloc(32, accountByte)),
    programOwner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"],
    dataBase64: data.toString("base64"),
    reportedSpace: data.length,
  };
}
function structure(balances, options = {}) {
  const total = balances.reduce((sum, [, value]) => sum + BigInt(value), 0n);
  return normalizeSolanaHolderStructure({
    mintAddress: MINT,
    tokenProgram: options.tokenProgram ?? "spl-token",
    decimals: options.decimals ?? 6,
    currentMintSupplyRaw: options.supply ?? SUPPLY,
    mintExtensionTypes: options.mintExtensionTypes ?? [],
    pages: [{ accounts: balances.map(([ownerByte, amount], index) => account(ownerByte, amount, ownerByte + 64 + index)), paginationKey: null, contextSlot: options.slot ?? 100 }],
    fetchedAt: options.fetchedAt ?? "2026-01-01T00:00:00.000Z",
  });
}
function record(balances, options = {}) {
  return createSolanaHolderSnapshotRecord(structure(balances, options));
}
function compare(before, after) {
  return compareSolanaHolderSnapshots(before, after);
}
function owner(result, addressByte) {
  const address = encodeSolanaPublicKey(Buffer.alloc(32, addressByte));
  return result.authorities.find((entry) => entry.authorityAddress === address);
}

test("snapshot IDs are deterministic, content-sensitive, and exclude snapshotId itself", () => {
  const first = structure([[1, "20"]]);
  const same = structure([[1, "20"]]);
  const changed = structure([[1, "21"]]);
  const id = calculateSolanaHolderSnapshotId(first);
  assert.equal(id, calculateSolanaHolderSnapshotId(same));
  assert.notEqual(id, calculateSolanaHolderSnapshotId(changed));
  assert.match(id, /^sha256:[0-9a-f]{64}$/);
  const created = createSolanaHolderSnapshotRecord(first);
  const suppliedIdVariant = { ...created, snapshotId: "sha256:" + "0".repeat(64) };
  assert.equal(calculateSolanaHolderSnapshotId(suppliedIdVariant.snapshot), id);
  assert.throws(() => compareSolanaHolderSnapshots(suppliedIdVariant, created), /snapshot ID/);
});

test("snapshot records clone and deeply freeze their normalized evidence", () => {
  const input = structure([[1, "20"]]);
  const saved = createSolanaHolderSnapshotRecord(input);
  input.rawOwnerAuthorities[0].balanceRaw = "99";
  assert.equal(saved.snapshot.rawOwnerAuthorities[0].balanceRaw, "20");
  assert.equal(saved.snapshotId, calculateSolanaHolderSnapshotId(saved.snapshot));
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.snapshot), true);
  assert.equal(Object.isFrozen(saved.snapshot.rawOwnerAuthorities), true);
  assert.equal(Object.isFrozen(saved.snapshot.rawOwnerAuthorities[0]), true);
});

test("identical holder evidence captured at different times has distinct IDs and compares", () => {
  const before = record([[1, "20"]]);
  const after = record([[1, "20"]], { fetchedAt: "2026-01-02T00:00:00.000Z", slot: 101 });
  assert.notEqual(before.snapshotId, after.snapshotId);
  assert.equal(owner(compare(before, after), 1).transition, "positive_both");
});

test("positive balances compare as increased, decreased, and unchanged with exact signed deltas", () => {
  const before = record([[1, "20"]]);
  assert.equal(owner(compare(before, record([[1, "30"]], { fetchedAt: "2026-01-02T00:00:00Z" })), 1).balanceDeltaRaw.value, "10");
  assert.equal(owner(compare(record([[1, "30"]]), record([[1, "20"]], { fetchedAt: "2026-01-02T00:00:00Z" })), 1).balanceDeltaRaw.value, "-10");
  const same = owner(compare(before, record([[1, "20"]], { fetchedAt: "2026-01-02T00:00:00Z" })), 1);
  assert.equal(same.transition, "positive_both");
  assert.equal(same.balanceDeltaRaw.value, "0");
});

test("a positive owner absent from a fully complete later snapshot is not_positive zero", () => {
  const result = compare(record([[1, "20"]]), record([[2, "30"]], { fetchedAt: "2026-01-02T00:00:00Z" }));
  const side = owner(result, 1);
  assert.deepEqual(side.later, { status: "not_positive", balanceRaw: "0", basis: "complete_positive_owner_set" });
  assert.equal(side.transition, "positive_earlier_only");
  assert.equal(side.balanceDeltaRaw.value, "-20");
});

test("a newly positive owner absent from a fully complete earlier snapshot has zero then positive", () => {
  const result = compare(record([[1, "20"]]), record([[1, "20"], [2, "30"]], { fetchedAt: "2026-01-02T00:00:00Z" }));
  const side = owner(result, 2);
  assert.deepEqual(side.earlier, { status: "not_positive", balanceRaw: "0", basis: "complete_positive_owner_set" });
  assert.equal(side.transition, "positive_later_only");
  assert.equal(side.balanceDeltaRaw.value, "30");
});

for (const [label, side] of [["earlier", "earlier"], ["later", "later"]]) {
  test(`incomplete ${label} enumeration keeps absent authorities unknown`, () => {
    const firstSnapshot = structure([[1, "20"]]);
    const secondSnapshot = structure([[2, "30"]], { fetchedAt: "2026-01-02T00:00:00Z" });
    (side === "earlier" ? firstSnapshot : secondSnapshot).enumeration.completeness = "partial";
    const result = compare(createSolanaHolderSnapshotRecord(firstSnapshot), createSolanaHolderSnapshotRecord(secondSnapshot));
    const absent = owner(result, side === "earlier" ? 2 : 1);
    assert.equal(absent[side].status, "unknown");
    assert.equal(absent[side].reason, "enumeration_incomplete");
    assert.equal(absent.balanceDeltaRaw.status, "unavailable");
    assert.equal(result.observedPositiveOwnerCountDelta.completeness, "partial");
  });
}

test("explicitly observed positive balances stay exact when unrelated amount coverage is partial", () => {
  const before = record([[1, "20"]], { mintExtensionTypes: [1] });
  const after = record([[1, "35"]], { fetchedAt: "2026-01-02T00:00:00Z", mintExtensionTypes: [1] });
  const compared = owner(compare(before, after), 1);
  assert.deepEqual(compared.earlier, { status: "positive_observed", balanceRaw: "20" });
  assert.deepEqual(compared.later, { status: "positive_observed", balanceRaw: "35" });
  assert.deepEqual(compared.balanceDeltaRaw, { status: "available", value: "15", completeness: "partial" });
});

for (const [label, side] of [["earlier", "earlier"], ["later", "later"]]) {
  test(`partial ${label} amount coverage keeps absent authorities unknown`, () => {
    const first = structure([[1, "20"]], { mintExtensionTypes: side === "earlier" ? [1] : [] });
    const second = structure([[2, "30"]], { fetchedAt: "2026-01-02T00:00:00Z", mintExtensionTypes: side === "later" ? [1] : [] });
    const result = compare(createSolanaHolderSnapshotRecord(first), createSolanaHolderSnapshotRecord(second));
    const absent = owner(result, side === "earlier" ? 2 : 1);
    assert.equal(absent[side].status, "unknown");
    assert.equal(absent[side].reason, "amount_coverage_partial");
    assert.equal(absent.balanceDeltaRaw.status, "unavailable");
  });
}

test("supply inconsistency prevents absence-to-zero inference", () => {
  const first = structure([[1, "700"]], { supply: "100" });
  const second = structure([[2, "30"]], { fetchedAt: "2026-01-02T00:00:00Z" });
  const absent = owner(compare(createSolanaHolderSnapshotRecord(first), createSolanaHolderSnapshotRecord(second)), 2);
  assert.equal(absent.earlier.status, "unknown");
  assert.equal(absent.earlier.reason, "supply_inconsistency");
  assert.equal(absent.balanceDeltaRaw.status, "unavailable");
});

test("zero supply is valid evidence but concentration changes remain unavailable", () => {
  const before = record([], { supply: "0" });
  const after = record([], { supply: "0", fetchedAt: "2026-01-02T00:00:00Z" });
  const result = compare(before, after);
  assert.deepEqual(result.concentrationPercentagePointDeltas.top1, {
    status: "unavailable", percentagePointDelta: null, reason: "both_unavailable",
    earlierReason: "zero_supply", laterReason: "zero_supply",
  });
});

test("huge balances and signed deltas remain exact beyond Number.MAX_SAFE_INTEGER", () => {
  const max = "18446744073709551615";
  const before = record([[1, "18446744073709551614"]], { supply: max });
  const after = record([[1, "1"]], { supply: max, fetchedAt: "2026-01-02T00:00:00Z" });
  assert.equal(owner(compare(before, after), 1).balanceDeltaRaw.value, "-18446744073709551613");
});

test("duplicate, malformed, zero, and noncanonical owner authorities are rejected", () => {
  const original = structure([[1, "20"], [2, "30"]]);
  for (const mutate of [
    (s) => { s.rawOwnerAuthorities[1].ownerAddress = s.rawOwnerAuthorities[0].ownerAddress; },
    (s) => { s.rawOwnerAuthorities[0].ownerAddress = "bad-address"; },
    (s) => { s.rawOwnerAuthorities[0].balanceRaw = "0"; },
    (s) => { s.rawOwnerAuthorities[0].balanceRaw = "030"; },
  ]) {
    const malformed = structuredClone(original);
    mutate(malformed);
    assert.throws(() => createSolanaHolderSnapshotRecord(malformed));
  }
});

test("raw owner count and account/state reconciliation contradictions are rejected", () => {
  const source = structure([[1, "20"]]);
  const badCount = structuredClone(source);
  badCount.rawOwnerCount += 1;
  assert.throws(() => createSolanaHolderSnapshotRecord(badCount), /raw owner count/);
  const badState = structuredClone(source);
  badState.tokenAccountStateSummary.initialized.tokenAccountCount += 1;
  assert.throws(() => createSolanaHolderSnapshotRecord(badState), /token account states/);
});

test("mint, token program, and decimals mismatches are rejected", () => {
  const before = record([[1, "20"]]);
  const variants = [
    (s) => { s.mintAddress = encodeSolanaPublicKey(Buffer.alloc(32, 9)); },
    (s) => { s.tokenProgram = "token-2022"; },
    (s) => { s.decimals = 7; },
  ];
  for (const mutate of variants) {
    const changed = structure([[1, "20"]], { fetchedAt: "2026-01-02T00:00:00Z" });
    mutate(changed);
    assert.throws(() => compare(before, createSolanaHolderSnapshotRecord(changed)), /mismatch/);
  }
});

test("malformed, equal, and reversed capture timestamps are rejected", () => {
  const before = record([[1, "20"]]);
  const equal = record([[1, "20"]]);
  assert.throws(() => compare(before, equal), /strictly increasing/);
  const reversed = record([[1, "20"]], { fetchedAt: "2025-12-31T23:59:59.000Z" });
  assert.throws(() => compare(before, reversed), /strictly increasing/);
  const malformed = { ...record([[1, "20"]], { fetchedAt: "2026-01-02T00:00:00.000Z" }) };
  malformed.snapshot = { ...malformed.snapshot, fetchedAt: "not-a-date" };
  malformed.snapshotId = calculateSolanaHolderSnapshotId(malformed.snapshot);
  assert.throws(() => compare(before, malformed), /fetchedAt/);
});

test("authority union order is lexicographic and input records are not mutated", () => {
  const before = record([[1, "20"], [3, "70"]], { slot: 100 });
  const after = record([[2, "30"], [3, "70"]], { fetchedAt: "2026-01-02T00:00:00Z", slot: 200 });
  const beforeCopy = structuredClone(before);
  const afterCopy = structuredClone(after);
  const result = compare(before, after);
  assert.deepEqual(result.authorities.map((entry) => entry.authorityAddress), result.authorities.map((entry) => entry.authorityAddress).slice().sort());
  assert.deepEqual(before, beforeCopy);
  assert.deepEqual(after, afterCopy);
  assert.deepEqual(result.provenance.earlierEnumeration.contextSlots, [100]);
  assert.deepEqual(result.provenance.laterEnumeration.contextSlots, [200]);
});

test("concentration deltas cover available, one unavailable, and both unavailable inputs", () => {
  const before = record([[1, "200"]]);
  const after = record([[1, "300"]], { fetchedAt: "2026-01-02T00:00:00Z" });
  const available = compare(before, after).concentrationPercentagePointDeltas.top1;
  assert.deepEqual(available, { status: "available", percentagePointDelta: "10.000000", completeness: "complete" });

  for (const incompleteSide of ["earlier", "later"]) {
    const earlierSnapshot = structure([[1, "200"]]);
    const laterSnapshot = structure([[1, "300"]], { fetchedAt: "2026-01-02T00:00:00Z" });
    (incompleteSide === "earlier" ? earlierSnapshot : laterSnapshot).enumeration.completeness = "partial";
    const partialDelta = compare(
      createSolanaHolderSnapshotRecord(earlierSnapshot),
      createSolanaHolderSnapshotRecord(laterSnapshot),
    ).concentrationPercentagePointDeltas.top1;
    assert.deepEqual(partialDelta, { status: "available", percentagePointDelta: "10.000000", completeness: "partial" });
  }

  const partial = record([[1, "300"]], { fetchedAt: "2026-01-02T00:00:00Z", mintExtensionTypes: [1] });
  const oneUnavailable = compare(before, partial).concentrationPercentagePointDeltas.top1;
  assert.equal(oneUnavailable.status, "unavailable");
  assert.equal(oneUnavailable.reason, "later_unavailable");
  assert.equal(oneUnavailable.laterReason, "unsupported_balance_affecting_extension");
  const bothUnavailable = compare(partial, record([[1, "300"]], { fetchedAt: "2026-01-03T00:00:00Z", mintExtensionTypes: [1] })).concentrationPercentagePointDeltas.top1;
  assert.equal(bothUnavailable.reason, "both_unavailable");
});

test("observed positive-owner count delta is complete or partial according to source evidence", () => {
  const before = record([[1, "20"]]);
  const after = record([[1, "20"], [2, "30"]], { fetchedAt: "2026-01-02T00:00:00Z" });
  assert.deepEqual(compare(before, after).observedPositiveOwnerCountDelta, { status: "available", value: 1, completeness: "complete" });
  const partial = record([[1, "20"], [2, "30"]], { fetchedAt: "2026-01-02T00:00:00Z", mintExtensionTypes: [1] });
  assert.deepEqual(compare(before, partial).observedPositiveOwnerCountDelta, { status: "available", value: 1, completeness: "partial" });
});

test("different context slots are permitted and no canonical slot is invented", () => {
  const firstSnapshot = structure([[1, "20"]], { slot: 100 });
  firstSnapshot.enumeration.pageCount = 2;
  firstSnapshot.enumeration.contextSlots = [100, 101];
  const secondSnapshot = structure([[1, "20"]], { slot: 200, fetchedAt: "2026-01-02T00:00:00Z" });
  const result = compare(createSolanaHolderSnapshotRecord(firstSnapshot), createSolanaHolderSnapshotRecord(secondSnapshot));
  assert.deepEqual(result.provenance.earlierEnumeration.contextSlots, [100, 101]);
  assert.deepEqual(result.provenance.laterEnumeration.contextSlots, [200]);
  assert.equal(Object.hasOwn(result.provenance, "canonicalSlot"), false);
});

