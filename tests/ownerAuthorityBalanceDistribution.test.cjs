const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeOwnerAuthorityBalanceDistribution } = require("../dist/normalization/ownerAuthorityBalanceDistribution.js");

const MINT = "11111111111111111111111111111111";
const SNAPSHOT_AT = "2026-09-30T12:00:00.000Z";
const PROFILE_PERCENTILES = [10, 25, 50, 75, 90, 99, 100];

function snapshot(balances, overrides = {}) {
  const rawOwnerAuthorities = balances.map((balanceRaw) => ({ balanceRaw: String(balanceRaw) }));
  return {
    chain: "solana",
    assetAddress: MINT,
    snapshotAt: SNAPSHOT_AT,
    decimals: 6,
    currentSupplyRaw: "1000000000",
    enumeration: {
      completeness: "complete",
      slotConsistency: "not_guaranteed",
      pageCount: 2,
      contextSlots: [100, 101],
    },
    amountCoverage: {
      state: "complete",
      unsupportedExtensionTypes: [],
      reason: null,
    },
    rawOwnerCount: rawOwnerAuthorities.length,
    rawOwnerAuthorities,
    ...overrides,
  };
}

function normalize(balances, overrides = {}) {
  return normalizeOwnerAuthorityBalanceDistribution(snapshot(balances, overrides));
}

test("returns null distribution bounds and share for no positive owner authorities", () => {
  const result = normalize([]);
  assert.equal(result.population, "positive_owner_authorities");
  assert.equal(result.observedOwnerAuthorityCount, 0);
  assert.equal(result.minimumBalanceRaw, null);
  assert.equal(result.maximumBalanceRaw, null);
  assert.equal(result.medianBalanceRaw, null);
  assert.deepEqual(result.quantilesRaw, { p25: null, p50: null, p75: null, p90: null, p99: null });
  assert.equal(result.distinctBalanceCount, 0);
  assert.equal(result.repeatedBalanceGroupCount, 0);
  assert.equal(result.authoritiesInRepeatedBalanceGroups, 0);
  assert.equal(result.authorityShareInRepeatedBalanceGroups, null);
  assert.deepEqual(result.repeatedBalanceGroups, []);
  assert.equal(result.observedPositiveOwnerAuthorityBalanceRaw, "0");
  assert.deepEqual(result.cumulativeOwnerBalanceProfile, PROFILE_PERCENTILES.map((ownerPercentile) => ({
    ownerPercentile,
    includedOwnerAuthorityCount: 0,
    cumulativeObservedBalanceRaw: "0",
    cumulativeObservedBalanceShare: null,
  })));
});

test("summarizes one owner authority without changing its exact balance", () => {
  const result = normalize(["42"]);
  assert.equal(result.minimumBalanceRaw, "42");
  assert.equal(result.maximumBalanceRaw, "42");
  assert.equal(result.medianBalanceRaw, "42");
  assert.deepEqual(result.quantilesRaw, { p25: "42", p50: "42", p75: "42", p90: "42", p99: "42" });
  assert.equal(result.distinctBalanceCount, 1);
  assert.equal(result.repeatedBalanceGroupCount, 0);
  assert.equal(result.observedPositiveOwnerAuthorityBalanceRaw, "42");
  assert.deepEqual(result.cumulativeOwnerBalanceProfile, PROFILE_PERCENTILES.map((ownerPercentile) => ({
    ownerPercentile,
    includedOwnerAuthorityCount: 1,
    cumulativeObservedBalanceRaw: "42",
    cumulativeObservedBalanceShare: "100.000000",
  })));
});

test("uses exact ceiling coordinate counts for small populations", () => {
  const result = normalize(["1", "2", "3", "4"]);
  assert.deepEqual(result.cumulativeOwnerBalanceProfile.map((point) => point.includedOwnerAuthorityCount), [1, 1, 2, 3, 4, 4, 4]);
});

test("profile uses ascending balances and nearest-rank cumulative sums for odd populations", () => {
  const result = normalize(["100", "1", "4", "2", "3"]);
  assert.equal(result.observedPositiveOwnerAuthorityBalanceRaw, "110");
  assert.deepEqual(result.cumulativeOwnerBalanceProfile.map((point) => point.cumulativeObservedBalanceRaw), ["1", "3", "6", "10", "110", "110", "110"]);
  assert.deepEqual(result.cumulativeOwnerBalanceProfile.map((point) => point.cumulativeObservedBalanceShare), [
    "0.909091", "2.727273", "5.454545", "9.090909", "100.000000", "100.000000", "100.000000",
  ]);
});

test("profile uses exact ceiling coordinate counts for even populations", () => {
  const result = normalize(["100", "1", "3", "2"]);
  assert.deepEqual(result.cumulativeOwnerBalanceProfile.map((point) => point.includedOwnerAuthorityCount), [1, 1, 2, 3, 4, 4, 4]);
  assert.deepEqual(result.cumulativeOwnerBalanceProfile.map((point) => point.cumulativeObservedBalanceRaw), ["1", "1", "3", "6", "106", "106", "106"]);
});

test("equal-balance ties remain deterministic and p100 includes every authority", () => {
  const result = normalize(["5", "1", "1", "1"]);
  assert.deepEqual(result.cumulativeOwnerBalanceProfile.map((point) => point.cumulativeObservedBalanceRaw), ["1", "1", "2", "3", "8", "8", "8"]);
  const finalPoint = result.cumulativeOwnerBalanceProfile.at(-1);
  assert.equal(finalPoint.includedOwnerAuthorityCount, result.observedOwnerAuthorityCount);
  assert.equal(finalPoint.cumulativeObservedBalanceRaw, result.observedPositiveOwnerAuthorityBalanceRaw);
  assert.equal(finalPoint.cumulativeObservedBalanceShare, "100.000000");
});

test("profile exposes a highly skewed low-balance tail without classifying it", () => {
  const result = normalize(["1", "1", "1", "1", "996"]);
  assert.deepEqual(result.cumulativeOwnerBalanceProfile.map((point) => point.cumulativeObservedBalanceRaw), ["1", "2", "3", "4", "1000", "1000", "1000"]);
});

test("profile balances and shares are monotonic", () => {
  const profile = normalize(["19", "1", "80", "3", "7", "11"]).cumulativeOwnerBalanceProfile;
  const shareToScaledInteger = (share) => BigInt(share.replace(".", ""));
  for (let index = 1; index < profile.length; index += 1) {
    assert.ok(BigInt(profile[index].cumulativeObservedBalanceRaw) >= BigInt(profile[index - 1].cumulativeObservedBalanceRaw));
    assert.ok(shareToScaledInteger(profile[index].cumulativeObservedBalanceShare) >= shareToScaledInteger(profile[index - 1].cumulativeObservedBalanceShare));
  }
});

test("profile preserves balances above JavaScript safe integer range exactly", () => {
  const result = normalize(["9007199254740993", "9007199254740992"]);
  assert.equal(result.observedPositiveOwnerAuthorityBalanceRaw, "18014398509481985");
  assert.deepEqual(result.cumulativeOwnerBalanceProfile.map((point) => point.cumulativeObservedBalanceRaw), [
    "9007199254740992", "9007199254740992", "9007199254740992", "18014398509481985",
    "18014398509481985", "18014398509481985", "18014398509481985",
  ]);
});

test("profiles accepted observed rows exactly and preserves partial enumeration coverage", () => {
  const result = normalize(["9007199254740993", "7"], {
    currentSupplyRaw: "9007199254741001",
    enumeration: {
      completeness: "partial",
      slotConsistency: "not_guaranteed",
      pageCount: 1,
      contextSlots: [123],
    },
  });
  assert.equal(result.observedOwnerAuthorityCount, 2);
  assert.equal(result.observedPositiveOwnerAuthorityBalanceRaw, "9007199254741000");
  assert.equal(result.minimumBalanceRaw, "7");
  assert.equal(result.maximumBalanceRaw, "9007199254740993");
  assert.deepEqual(result.quantilesRaw, {
    p25: "7", p50: "7", p75: "9007199254740993", p90: "9007199254740993", p99: "9007199254740993",
  });
  assert.equal(result.coverage.state, "partial");
  assert.equal(result.coverage.enumerationCompleteness, "partial");
  assert.deepEqual(result.coverage.contextSlots, [123]);
});

test("profile supports maximum u64-scale balances and cumulative sums larger than u64", () => {
  const maxU64 = "18446744073709551615";
  const result = normalize([maxU64, maxU64], { currentSupplyRaw: maxU64 });
  assert.equal(result.observedPositiveOwnerAuthorityBalanceRaw, "36893488147419103230");
  assert.equal(result.cumulativeOwnerBalanceProfile.at(-1).cumulativeObservedBalanceRaw, "36893488147419103230");
  assert.equal(result.cumulativeOwnerBalanceProfile.at(-1).cumulativeObservedBalanceShare, "100.000000");
});

test("uses nearest-rank quantiles for an odd population", () => {
  const result = normalize(["100", "1", "4", "2", "3"]);
  assert.deepEqual(result.quantilesRaw, {
    p25: "2", p50: "3", p75: "4", p90: "100", p99: "100",
  });
  assert.equal(result.medianBalanceRaw, "3");
});

test("uses nearest-rank quantiles for an even population without averaging the median", () => {
  const result = normalize(["100", "1", "3", "2"]);
  assert.deepEqual(result.quantilesRaw, {
    p25: "1", p50: "2", p75: "3", p90: "100", p99: "100",
  });
  assert.equal(result.medianBalanceRaw, "2");
});

test("reports exact frequencies when all owner authorities have identical balances", () => {
  const result = normalize(["7", "7", "7", "7"]);
  assert.equal(result.distinctBalanceCount, 1);
  assert.equal(result.repeatedBalanceGroupCount, 1);
  assert.equal(result.authoritiesInRepeatedBalanceGroups, 4);
  assert.equal(result.authorityShareInRepeatedBalanceGroups, "100.000000");
  assert.deepEqual(result.repeatedBalanceGroups, [{ balanceRaw: "7", ownerAuthorityCount: 4 }]);
});

test("counts distinct and repeated exact balances and sorts groups by frequency then raw balance", () => {
  const result = normalize(["4", "3", "2", "1", "3", "2", "2", "1", "9"]);
  assert.equal(result.distinctBalanceCount, 5);
  assert.equal(result.repeatedBalanceGroupCount, 3);
  assert.equal(result.authoritiesInRepeatedBalanceGroups, 7);
  assert.equal(result.authorityShareInRepeatedBalanceGroups, "77.777778");
  assert.deepEqual(result.repeatedBalanceGroups, [
    { balanceRaw: "2", ownerAuthorityCount: 3 },
    { balanceRaw: "1", ownerAuthorityCount: 2 },
    { balanceRaw: "3", ownerAuthorityCount: 2 },
  ]);
});

test("all unique balances create no repeated-balance groups", () => {
  const result = normalize(["9", "1", "7", "3"]);
  assert.equal(result.distinctBalanceCount, 4);
  assert.equal(result.repeatedBalanceGroupCount, 0);
  assert.equal(result.authoritiesInRepeatedBalanceGroups, 0);
  assert.equal(result.authorityShareInRepeatedBalanceGroups, "0.000000");
  assert.deepEqual(result.repeatedBalanceGroups, []);
});

test("retains maximum u64-scale balances exactly without Number conversion", () => {
  const maxU64 = "18446744073709551615";
  const result = normalize([maxU64, maxU64], { currentSupplyRaw: maxU64 });
  assert.equal(result.minimumBalanceRaw, maxU64);
  assert.equal(result.maximumBalanceRaw, maxU64);
  assert.equal(result.quantilesRaw.p50, maxU64);
  assert.deepEqual(result.repeatedBalanceGroups, [{ balanceRaw: maxU64, ownerAuthorityCount: 2 }]);
});

test("distinguishes adjacent balances above JavaScript's exact integer range", () => {
  const result = normalize(["9007199254740993", "9007199254740992"]);
  assert.equal(result.minimumBalanceRaw, "9007199254740992");
  assert.equal(result.maximumBalanceRaw, "9007199254740993");
  assert.equal(result.quantilesRaw.p50, "9007199254740992");
  assert.equal(result.distinctBalanceCount, 2);
  assert.deepEqual(result.repeatedBalanceGroups, []);
});

test("keeps repeated-balance evidence compact and reports omitted repeated groups", () => {
  const balances = [];
  for (let balance = 1; balance <= 26; balance += 1) balances.push(String(balance), String(balance));
  const result = normalize(balances);
  assert.equal(result.distinctBalanceCount, 26);
  assert.equal(result.repeatedBalanceGroupCount, 26);
  assert.equal(result.repeatedBalanceGroups.length, 25);
  assert.equal(result.repeatedBalanceGroupsOmitted, 1);
  assert.deepEqual(result.repeatedBalanceGroups.slice(0, 3), [
    { balanceRaw: "1", ownerAuthorityCount: 2 },
    { balanceRaw: "2", ownerAuthorityCount: 2 },
    { balanceRaw: "3", ownerAuthorityCount: 2 },
  ]);
});

test("retains snapshot provenance and non-atomic pagination semantics", () => {
  const result = normalize(["1"]);
  assert.deepEqual(result.coverage, {
    state: "complete",
    source: "normalized_holder_snapshot",
    sourceSnapshotAt: SNAPSHOT_AT,
    enumerationCompleteness: "complete",
    slotConsistency: "not_guaranteed",
    pageCount: 2,
    contextSlots: [100, 101],
    amountCoverageState: "complete",
    amountCoverageReason: null,
    unsupportedExtensionTypes: [],
  });
});

test("inherits partial Token-2022 amount coverage", () => {
  const result = normalize(["1", "1"], {
    amountCoverage: {
      state: "partial",
      unsupportedExtensionTypes: [4, 17],
      reason: "unsupported_balance_affecting_extension",
    },
  });
  assert.equal(result.coverage.state, "partial");
  assert.equal(result.coverage.amountCoverageState, "partial");
  assert.deepEqual(result.coverage.unsupportedExtensionTypes, [4, 17]);
  assert.equal(result.cumulativeOwnerBalanceProfile.at(-1).cumulativeObservedBalanceShare, "100.000000");
});

test("inherits partial coverage when observed balances exceed current supply", () => {
  const result = normalize(["70", "50"], {
    currentSupplyRaw: "100",
    amountCoverage: {
      state: "partial",
      unsupportedExtensionTypes: [],
      reason: "supply_inconsistency",
    },
  });
  assert.equal(result.coverage.state, "partial");
  assert.equal(result.coverage.amountCoverageReason, "supply_inconsistency");
  assert.equal(result.observedPositiveOwnerAuthorityBalanceRaw, "120");
  assert.equal(result.cumulativeOwnerBalanceProfile.at(-1).cumulativeObservedBalanceShare, "100.000000");
});

test("downgrades contradictory complete coverage when observed balances exceed supply", () => {
  const result = normalize(["70", "50"], {
    currentSupplyRaw: "100",
    amountCoverage: {
      state: "complete",
      unsupportedExtensionTypes: [],
      reason: null,
    },
  });
  assert.equal(result.coverage.state, "partial");
  assert.equal(result.coverage.amountCoverageState, "complete");
  assert.equal(result.coverage.amountCoverageReason, "supply_inconsistency");
});

test("zero current mint supply does not change count-based repeated-balance evidence", () => {
  const result = normalize(["5", "5"], { currentSupplyRaw: "0" });
  assert.equal(result.currentSupplyRaw, "0");
  assert.equal(result.repeatedBalanceGroupCount, 1);
  assert.equal(result.authorityShareInRepeatedBalanceGroups, "100.000000");
  assert.equal(result.observedPositiveOwnerAuthorityBalanceRaw, "10");
  assert.equal(result.cumulativeOwnerBalanceProfile.at(-1).cumulativeObservedBalanceShare, "100.000000");
});

test("marks incomplete source enumeration as partial", () => {
  const result = normalize(["1"], {
    enumeration: {
      completeness: "partial",
      slotConsistency: "unknown",
      pageCount: 1,
      contextSlots: [100],
    },
  });
  assert.equal(result.coverage.state, "partial");
  assert.equal(result.coverage.enumerationCompleteness, "partial");
  assert.equal(result.cumulativeOwnerBalanceProfile.at(-1).cumulativeObservedBalanceShare, "100.000000");
});

test("rejects zero-balance-only authority leakage into the positive-balance population", () => {
  assert.throws(() => normalize(["0"]), /only positive owner-authority balances/);
});

test("rejects malformed raw balances and a count that does not match the snapshot", () => {
  assert.throws(() => normalize(["01"]), /non-negative raw integer string/);
  assert.throws(() => normalize(["1"], { rawOwnerCount: 2 }), /count does not match/);
});
