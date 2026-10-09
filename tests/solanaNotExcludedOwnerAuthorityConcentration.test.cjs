const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { deriveSolanaNotExcludedOwnerAuthorityConcentration } = require("../dist/normalization/solanaNotExcludedOwnerAuthorityConcentration.js");
const { deriveSolanaNotExcludedOwnerAuthorityConcentrationV2 } = require("../dist/normalization/solanaNotExcludedOwnerAuthorityConcentration.js");
const { createSolanaHolderSnapshotRecordV2 } = require("../dist/normalization/solanaHolderSnapshotComparison.js");
const { deriveSolanaAddressRoleEvidenceV2 } = require("../dist/normalization/solanaAddressRoleEvidence.js");
const { assessSolanaHolderExclusionsV2 } = require("../dist/normalization/solanaHolderExclusionAssessment.js");
const { deriveSolanaNotExcludedOwnerAuthorityPopulationV2 } = require("../dist/normalization/solanaNotExcludedOwnerAuthorityPopulation.js");
const { normalizeMarketSnapshot } = require("../dist/normalization/marketSnapshot.js");
const { normalizeSolanaHolderStructure } = require("../dist/normalization/solanaHolders.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { decodeSolanaPublicKey, encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const MINT = "11111111111111111111111111111111";
const FETCHED_AT = "2026-10-07T12:00:00.000Z";
const SNAPSHOT_ID = `sha256:${"a".repeat(64)}`;
const ASSESSMENT_VERSION = "solana-holder-exclusion-assessment-v1";
const INPUT_VERSION = "solana-not-excluded-owner-authority-population-v1";
const OUTPUT_VERSION = "solana-not-excluded-owner-authority-concentration-v1";

function address(seed) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 28);
  return encodeSolanaPublicKey(bytes);
}

function formatPercent(numeratorRaw, denominatorRaw) {
  const numerator = BigInt(numeratorRaw);
  const denominator = BigInt(denominatorRaw);
  const scaled = (numerator * 100n * 1_000_000n + denominator / 2n) / denominator;
  return `${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, "0")}`;
}

function evidence(rows = [], options = {}) {
  const subjects = rows.map((row) => ({
    subjectAddress: row.subjectAddress ?? address(row.seed),
    balanceRaw: String(row.balanceRaw),
    decision: row.decision ?? "retain",
  })).sort((left, right) => left.subjectAddress < right.subjectAddress ? -1 : left.subjectAddress > right.subjectAddress ? 1 : 0);
  const totals = {
    exclude: { subjectCount: 0, balance: 0n },
    retain: { subjectCount: 0, balance: 0n },
    unresolved: { subjectCount: 0, balance: 0n },
  };
  let rawBalance = 0n;
  let notExcludedBalance = 0n;
  let notExcludedCount = 0;
  for (const subject of subjects) {
    const balance = BigInt(subject.balanceRaw);
    rawBalance += balance;
    totals[subject.decision].subjectCount += 1;
    totals[subject.decision].balance += balance;
    if (subject.decision !== "exclude") {
      notExcludedBalance += balance;
      notExcludedCount += 1;
    }
  }
  const supply = String(options.supply ?? "1000");
  const supplyDifference = options.supplyDifference ?? (BigInt(supply) - rawBalance).toString();
  const inconsistent = BigInt(supplyDifference) < 0n;
  const extensions = [...(options.unsupportedExtensionTypes ?? [])].sort((a, b) => a - b);
  const partial = options.coverageState === "partial" || inconsistent || extensions.length > 0;
  const coverageReason = options.coverageReason ?? (inconsistent ? "supply_inconsistency"
    : extensions.length > 0 ? "unsupported_balance_affecting_extension" : null);
  const notExcludedBalanceRaw = options.notExcludedBalanceRaw ?? notExcludedBalance.toString();
  const notExcludedSubjectCount = options.notExcludedSubjectCount ?? notExcludedCount;
  const byDecision = Object.fromEntries(Object.entries(totals).map(([decision, total]) => [decision, {
    subjectCount: total.subjectCount,
    observedBalanceRaw: total.balance.toString(),
  }]));

  return {
    schemaVersion: INPUT_VERSION,
    chain: "solana",
    mintAddress: options.mintAddress ?? MINT,
    policyVersion: options.policyVersion ?? "solana-address-exclusion-policy-v1",
    source: {
      holderSnapshotId: options.holderSnapshotId ?? SNAPSHOT_ID,
      exclusionAssessmentSchemaVersion: options.exclusionAssessmentSchemaVersion ?? ASSESSMENT_VERSION,
      holderFetchedAt: options.holderFetchedAt ?? FETCHED_AT,
      enumeration: options.enumeration ?? {
        completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [700, 701],
      },
      amountCoverage: options.amountCoverage ?? {
        state: partial ? "partial" : "complete",
        unsupportedExtensionTypes: extensions,
        reason: coverageReason,
      },
      currentMintSupplyRaw: supply,
      supplyDifferenceRaw: supplyDifference,
    },
    subjects,
    raw: {
      subjectCount: options.rawSubjectCount ?? subjects.length,
      observedPositiveBalanceRaw: options.rawObservedBalanceRaw ?? rawBalance.toString(),
    },
    byDecision: options.byDecision ?? byDecision,
    notExcluded: {
      subjectCount: notExcludedSubjectCount,
      observedBalanceRaw: notExcludedBalanceRaw,
    },
    reconciliation: options.reconciliation ?? {
      status: "reconciled",
      basis: "decision_categories_partition_observed_positive_owner_authority_rows",
    },
  };
}

function tokenAccount(ownerByte, amount, accountByte = ownerByte + 50) {
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

function rawHolder(rows, supply, mintExtensionTypes = []) {
  return normalizeSolanaHolderStructure({
    mintAddress: MINT,
    tokenProgram: "spl-token",
    decimals: 6,
    currentMintSupplyRaw: String(supply),
    mintExtensionTypes,
    pages: [{ accounts: rows.map((row) => tokenAccount(row.seed, row.balanceRaw)), paginationKey: null, contextSlot: 700 }],
    fetchedAt: FETCHED_AT,
  });
}

function v2Pipeline(rows, options = {}) {
  const holder = rawHolder(rows, options.supply ?? "1000", options.mintExtensionTypes ?? []);
  const partial = options.partial === true;
  let record;
  if (partial) {
    holder.enumeration.completeness = "partial";
    holder.concentration = Object.fromEntries([1, 5, 10, 20].map((n) => ["top" + n, {
      status: "unavailable", topN: n, numeratorRaw: null, denominatorRaw: holder.currentMintSupplyRaw,
      denominatorBasis: "current_mint_supply", percentage: null, reason: "enumeration_incomplete",
    }]));
    holder.acquisition = { stopReason: "request_timeout", configuredMaxPages: 20, requestedPageSize: 5000 };
    record = createSolanaHolderSnapshotRecordV2(holder);
  } else record = createSolanaHolderSnapshotRecordV2(holder, { completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20, requestedPageSize: 5000 });
  const resolution = {
    exists: true, isMint: true, mintAddress: MINT, tokenProgram: "spl-token", decimals: 6,
    rawSupply: holder.currentMintSupplyRaw,
    baseAuthorities: { mintAuthority: { status: "unset", address: null }, freezeAuthority: { status: "unset", address: null } },
  };
  const roles = deriveSolanaAddressRoleEvidenceV2(resolution, record, {
    status: "available", snapshot: normalizeMarketSnapshot("solana", MINT, [], FETCHED_AT),
  });
  const assessment = assessSolanaHolderExclusionsV2({ holderSnapshot: record, addressRoleEvidence: roles });
  const population = deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, assessment);
  return { holder, record, assessment, population };
}

test("valid current-policy evidence produces separate supply and observed-population metrics", () => {
  const input = evidence([
    { seed: 1, balanceRaw: "50", decision: "unresolved" },
    { seed: 2, balanceRaw: "30", decision: "retain" },
    { seed: 3, balanceRaw: "10", decision: "retain" },
    { seed: 4, balanceRaw: "5", decision: "unresolved" },
  ], { supply: "100" });
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(input);
  assert.equal(result.schemaVersion, OUTPUT_VERSION);
  assert.equal(result.chain, "solana");
  assert.equal(result.population.subjectType, "observed_positive_solana_owner_authorities");
  assert.equal(result.population.notExcludedSubjectCount, 4);
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.status, "available");
  assert.equal(result.notExcludedObservedPopulationTopNShare.status, "available");
});

test("V2 complete metrics equal V1 metrics for identical observations", () => {
  const holder = rawHolder([{ seed: 1, balanceRaw: "50" }, { seed: 2, balanceRaw: "30" }], "100");
  const population = evidence(holder.rawOwnerAuthorities.map((row) => ({ subjectAddress: row.ownerAddress, balanceRaw: row.balanceRaw })), { supply: "100" });
  const v1 = deriveSolanaNotExcludedOwnerAuthorityConcentration(population);
  const v2 = deriveSolanaNotExcludedOwnerAuthorityConcentrationV2(v2Pipeline([{ seed: 1, balanceRaw: "50" }, { seed: 2, balanceRaw: "30" }], { supply: "100" }).population);
  assert.deepEqual(v2.notExcludedTopNCurrentMintSupplyShare, v1.notExcludedTopNCurrentMintSupplyShare);
  assert.deepEqual(v2.notExcludedObservedPopulationTopNShare, v1.notExcludedObservedPopulationTopNShare);
});

test("partial V2 enumeration withholds global Top-N numerator but keeps observed-population share partial", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentrationV2(v2Pipeline(
    [{ seed: 1, balanceRaw: "50" }, { seed: 2, balanceRaw: "30" }], { supply: "100", partial: true },
  ).population);
  assert.deepEqual([result.notExcludedTopNCurrentMintSupplyShare.status, result.notExcludedTopNCurrentMintSupplyShare.reason], ["unavailable", "enumeration_incomplete"]);
  assert.deepEqual([result.notExcludedTopNCurrentMintSupplyShare.top1.numeratorRaw, result.notExcludedTopNCurrentMintSupplyShare.top1.percentage], [null, null]);
  assert.equal(result.notExcludedObservedPopulationTopNShare.status, "available");
  assert.equal(result.notExcludedObservedPopulationTopNShare.completeness, "partial");
  assert.deepEqual(result.notExcludedObservedPopulationTopNShare.partialReasons, ["enumeration_incomplete"]);
  assert.equal(result.notExcludedObservedPopulationTopNShare.top1.percentage, "62.500000");
});

test("V2 Metric B orders simultaneous enumeration, extension, and supply reasons deterministically", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentrationV2(v2Pipeline(
    [{ seed: 1, balanceRaw: "12" }, { seed: 2, balanceRaw: "10" }],
    { supply: "1", partial: true, mintExtensionTypes: [1] },
  ).population);
  assert.deepEqual(result.notExcludedObservedPopulationTopNShare.partialReasons,
    ["enumeration_incomplete", "unsupported_balance_affecting_extension", "supply_inconsistency"]);
  assert.deepEqual(result.notExcludedTopNCurrentMintSupplyShare.top1, {
    topN: 1, numeratorRaw: null, percentage: null,
  });
});

test("V2 complete enumeration with partial amount coverage remains partial and preserves exact Metric A behavior", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentrationV2(v2Pipeline(
    [{ seed: 1, balanceRaw: "50" }, { seed: 2, balanceRaw: "30" }],
    { supply: "100", mintExtensionTypes: [1] },
  ).population);
  assert.deepEqual([result.notExcludedTopNCurrentMintSupplyShare.status, result.notExcludedTopNCurrentMintSupplyShare.reason], ["unavailable", "partial_amount_coverage"]);
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top1.numeratorRaw, "50");
  assert.equal(result.notExcludedObservedPopulationTopNShare.completeness, "partial");
  assert.deepEqual(result.notExcludedObservedPopulationTopNShare.partialReasons, ["unsupported_balance_affecting_extension"]);
});

test("V2 rejects zero observed denominator as available and rejects malformed cross-stage provenance", () => {
  const zero = v2Pipeline([], { supply: "100", partial: true }).population;
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentrationV2(zero);
  assert.equal(result.notExcludedObservedPopulationTopNShare.status, "unavailable");
  const bad = structuredClone(zero);
  bad.source.exclusionAssessmentSchemaVersion = "solana-holder-exclusion-assessment-v1";
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentrationV2(bad));
});

test("V2 concentration does not mutate population input and its result is detached", () => {
  const input = v2Pipeline([{ seed: 1, balanceRaw: "50" }, { seed: 2, balanceRaw: "30" }], { supply: "100", partial: true }).population;
  const before = structuredClone(input);
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentrationV2(input);
  assert.deepEqual(input, before);
  result.source.amountCoverage.unsupportedExtensionTypes.push(42);
  assert.deepEqual(input, before);
});

test("Metric A equals raw concentration under current policy while Metric B uses the observed denominator", () => {
  const rows = [{ seed: 1, balanceRaw: "50" }, { seed: 2, balanceRaw: "30" }, { seed: 3, balanceRaw: "10" }, { seed: 4, balanceRaw: "5" }];
  const holder = rawHolder(rows, "100");
  const population = evidence(holder.rawOwnerAuthorities.map((owner, index) => ({
    subjectAddress: owner.ownerAddress,
    balanceRaw: owner.balanceRaw,
    decision: index === 0 ? "unresolved" : "retain",
  })), { supply: "100" });
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(population);
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top1.percentage, holder.concentration.top1.percentage);
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top5.percentage, holder.concentration.top5.percentage);
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top20.percentage, holder.concentration.top20.percentage);
  assert.equal(result.notExcludedObservedPopulationTopNShare.top1.percentage, "52.631579");
  assert.notEqual(result.notExcludedObservedPopulationTopNShare.top1.percentage, result.notExcludedTopNCurrentMintSupplyShare.top1.percentage);
});

test("calculates Top-1, Top-5, Top-10, and Top-20 after ranking the population", () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ seed: index + 1, balanceRaw: String(100 - index) }));
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence(rows, { supply: "5000" }));
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top1.numeratorRaw, "100");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top5.numeratorRaw, "490");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top10.numeratorRaw, "955");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top20.numeratorRaw, "1810");
});

test("fewer subjects than N use all remaining balances", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([
    { seed: 1, balanceRaw: "7" }, { seed: 2, balanceRaw: "3" },
  ], { supply: "20" }));
  for (const key of ["top5", "top10", "top20"]) {
    assert.equal(result.notExcludedTopNCurrentMintSupplyShare[key].numeratorRaw, "10");
    assert.equal(result.notExcludedObservedPopulationTopNShare[key].numeratorRaw, "10");
  }
});

test("equal-balance ties produce deterministic output independent of input row order", () => {
  const rows = [{ seed: 9, balanceRaw: "50" }, { seed: 3, balanceRaw: "50" }, { seed: 4, balanceRaw: "10" }];
  const first = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence(rows, { supply: "200" }));
  const second = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([...rows].reverse(), { supply: "200" }));
  assert.deepEqual(first, second);
  assert.equal(first.notExcludedTopNCurrentMintSupplyShare.top1.numeratorRaw, "50");
});

test("preserves exact balances above Number.MAX_SAFE_INTEGER", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([
    { seed: 1, balanceRaw: "9007199254740993" },
    { seed: 2, balanceRaw: "8000000000000000" },
  ], { supply: "18000000000000000" }));
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top1.numeratorRaw, "9007199254740993");
  assert.equal(result.notExcludedObservedPopulationTopNShare.denominatorRaw, "17007199254740993");
  assert.equal(result.notExcludedObservedPopulationTopNShare.top1.numeratorRaw, "9007199254740993");
});

test("uses six-decimal half-up percentage rounding", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([
    { seed: 1, balanceRaw: "1" },
  ], { supply: "200000000" }));
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top1.percentage, "0.000001");
  assert.equal(result.notExcludedObservedPopulationTopNShare.top1.percentage, "100.000000");
});

test("zero supply makes A unavailable but does not block a numeric B with positive observed balances", () => {
  const input = evidence([{ seed: 1, balanceRaw: "5" }], { supply: "0" });
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(input);
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.status, "unavailable");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.reason, "supply_inconsistency");
  assert.equal(result.notExcludedObservedPopulationTopNShare.status, "available");
  assert.equal(result.notExcludedObservedPopulationTopNShare.completeness, "partial");
  assert.equal(result.notExcludedObservedPopulationTopNShare.top1.percentage, "100.000000");
});

test("zero supply with an empty consistent population has A unavailable and B unavailable", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([], { supply: "0" }));
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.status, "unavailable");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.reason, "zero_supply");
  assert.equal(result.notExcludedObservedPopulationTopNShare.status, "unavailable");
  assert.equal(result.notExcludedObservedPopulationTopNShare.reason, "zero_not_excluded_observed_balance_total");
});

test("partial amount coverage makes A unavailable and B numeric with partial provenance", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([
    { seed: 1, balanceRaw: "30" }, { seed: 2, balanceRaw: "20" },
  ], { supply: "100", unsupportedExtensionTypes: [1, 5] }));
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.status, "unavailable");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.reason, "partial_amount_coverage");
  assert.equal(result.notExcludedObservedPopulationTopNShare.status, "available");
  assert.equal(result.notExcludedObservedPopulationTopNShare.completeness, "partial");
  assert.deepEqual(result.notExcludedObservedPopulationTopNShare.partialReasons, ["unsupported_balance_affecting_extension"]);
  assert.deepEqual(result.notExcludedObservedPopulationTopNShare.unsupportedExtensionTypes, [1, 5]);
  assert.equal(result.notExcludedObservedPopulationTopNShare.top1.percentage, "60.000000");
});

test("supply inconsistency makes A unavailable but keeps B numeric and partial", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([
    { seed: 1, balanceRaw: "70" }, { seed: 2, balanceRaw: "50" },
  ], { supply: "100" }));
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.status, "unavailable");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.reason, "supply_inconsistency");
  assert.equal(result.notExcludedObservedPopulationTopNShare.status, "available");
  assert.equal(result.notExcludedObservedPopulationTopNShare.completeness, "partial");
  assert.deepEqual(result.notExcludedObservedPopulationTopNShare.partialReasons, ["supply_inconsistency"]);
  assert.equal(result.source.supplyDifferenceRaw, "-20");
  assert.equal(result.notExcludedObservedPopulationTopNShare.top1.percentage, "58.333333");
});

test("accepts only Step 5B-2 amount-coverage combinations and preserves simultaneous partial causes", () => {
  const validCases = [
    {
      rows: [{ seed: 1, balanceRaw: "5" }],
      options: { supply: "10", amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null } },
      reasons: [],
    },
    {
      rows: [{ seed: 1, balanceRaw: "5" }],
      options: { supply: "10", amountCoverage: { state: "partial", unsupportedExtensionTypes: [1], reason: "unsupported_balance_affecting_extension" } },
      reasons: ["unsupported_balance_affecting_extension"],
    },
    {
      rows: [{ seed: 1, balanceRaw: "12" }],
      options: { supply: "10", amountCoverage: { state: "partial", unsupportedExtensionTypes: [], reason: "supply_inconsistency" } },
      reasons: ["supply_inconsistency"],
    },
    {
      rows: [{ seed: 1, balanceRaw: "12" }],
      options: { supply: "10", amountCoverage: { state: "partial", unsupportedExtensionTypes: [1], reason: "supply_inconsistency" } },
      reasons: ["unsupported_balance_affecting_extension", "supply_inconsistency"],
    },
  ];

  for (const { rows, options, reasons } of validCases) {
    const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence(rows, options));
    assert.equal(result.source.amountCoverage.state, options.amountCoverage.state);
    assert.deepEqual(result.notExcludedObservedPopulationTopNShare.partialReasons, reasons);
  }

  const invalidCases = [
    {
      rows: [{ seed: 1, balanceRaw: "5" }],
      options: { supply: "10", amountCoverage: { state: "partial", unsupportedExtensionTypes: [], reason: "supply_inconsistency" } },
    },
    {
      rows: [{ seed: 1, balanceRaw: "5" }],
      options: { supply: "10", amountCoverage: { state: "partial", unsupportedExtensionTypes: [1], reason: "supply_inconsistency" } },
    },
    {
      rows: [{ seed: 1, balanceRaw: "12" }],
      options: { supply: "10", amountCoverage: { state: "partial", unsupportedExtensionTypes: [], reason: "unsupported_balance_affecting_extension" } },
    },
    {
      rows: [{ seed: 1, balanceRaw: "12" }],
      options: { supply: "10", amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null } },
    },
  ];

  for (const { rows, options } of invalidCases) {
    assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence(rows, options)));
  }
});

test("empty not-excluded population with positive supply is a valid zero for A and unavailable for B", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([], { supply: "100" }));
  assert.equal(result.population.notExcludedSubjectCount, 0);
  assert.equal(result.population.notExcludedObservedBalanceRaw, "0");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.status, "available");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top20.numeratorRaw, "0");
  assert.equal(result.notExcludedTopNCurrentMintSupplyShare.top20.percentage, "0.000000");
  assert.equal(result.notExcludedObservedPopulationTopNShare.status, "unavailable");
  assert.equal(result.notExcludedObservedPopulationTopNShare.denominatorRaw, "0");
});

test("current policy rejects a forged all-subject exclusion state", () => {
  // The public v1 boundary rejects this policy-forbidden state; valid empty-population behavior
  // is covered separately without admitting forged v1 evidence.
  const invalid = evidence([{ seed: 1, balanceRaw: "5", decision: "exclude" }], { supply: "100" });
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(invalid), /cannot contain exclude/);
});

test("unresolved and retain decisions both contribute to notExcluded", () => {
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([
    { seed: 1, balanceRaw: "12", decision: "unresolved" },
    { seed: 2, balanceRaw: "8", decision: "retain" },
  ], { supply: "100" }));
  assert.equal(result.population.notExcludedSubjectCount, 2);
  assert.equal(result.population.notExcludedObservedBalanceRaw, "20");
  assert.deepEqual(result.population.byDecision.unresolved, { subjectCount: 1, observedBalanceRaw: "12" });
  assert.deepEqual(result.population.byDecision.retain, { subjectCount: 1, observedBalanceRaw: "8" });
});

test("rejects malformed schema, chain, policy, assessment version, and snapshot ID", () => {
  for (const [field, value] of [
    ["schemaVersion", "future"], ["chain", "base"], ["policyVersion", "unknown-policy"],
  ]) {
    const input = evidence([{ seed: 1, balanceRaw: "1" }]);
    input[field] = value;
    assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(input));
  }
  const badAssessmentVersion = evidence([{ seed: 1, balanceRaw: "1" }]);
  badAssessmentVersion.source.exclusionAssessmentSchemaVersion = "unknown";
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(badAssessmentVersion));
  const badSnapshotId = evidence([{ seed: 1, balanceRaw: "1" }]);
  badSnapshotId.source.holderSnapshotId = `${SNAPSHOT_ID}\n`;
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(badSnapshotId));
});

test("rejects malformed mint, timestamp, enumeration, and amount-coverage metadata", () => {
  const badMint = evidence([{ seed: 1, balanceRaw: "1" }]);
  badMint.mintAddress = `${MINT}\n`;
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(badMint));
  const badTime = evidence([{ seed: 1, balanceRaw: "1" }]);
  badTime.source.holderFetchedAt = "not-a-time";
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(badTime));
  const badSlots = evidence([{ seed: 1, balanceRaw: "1" }]);
  badSlots.source.enumeration.contextSlots.pop();
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(badSlots));
  for (const amountCoverage of [
    { state: "complete", unsupportedExtensionTypes: [1], reason: null },
    { state: "partial", unsupportedExtensionTypes: [], reason: "unsupported_balance_affecting_extension" },
    { state: "complete", unsupportedExtensionTypes: [], reason: "supply_inconsistency" },
  ]) {
    const input = evidence([{ seed: 1, balanceRaw: "1" }]);
    input.source.amountCoverage = amountCoverage;
    assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(input));
  }
});

test("rejects malformed, zero, noncanonical, or whitespace subject balances", () => {
  for (const balanceRaw of ["0", "01", "-1", "1.0", " 1", "1\n"]) {
    const input = evidence([{ seed: 1, balanceRaw: "1" }]);
    input.subjects[0].balanceRaw = balanceRaw;
    assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(input), /subject ordering, identity, balance, or decision/);
  }
});

test("rejects duplicate subjects and malformed addresses", () => {
  const duplicate = evidence([{ seed: 1, balanceRaw: "2" }, { seed: 1, balanceRaw: "1" }]);
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(duplicate));
  const malformed = evidence([{ seed: 1, balanceRaw: "1" }]);
  malformed.subjects[0].subjectAddress = "not-a-public-key";
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(malformed));
});

test("rejects raw, per-decision, notExcluded, and supply-difference reconciliation mismatches", () => {
  const badRaw = evidence([{ seed: 1, balanceRaw: "5" }]);
  badRaw.raw.subjectCount += 1;
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(badRaw), /raw totals/);
  const badDecision = evidence([{ seed: 1, balanceRaw: "5" }]);
  badDecision.byDecision.retain.observedBalanceRaw = "4";
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(badDecision), /decision totals/);
  const badNotExcluded = evidence([{ seed: 1, balanceRaw: "5" }]);
  badNotExcluded.notExcluded.subjectCount = 0;
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(badNotExcluded), /not-excluded totals/);
  const badDifference = evidence([{ seed: 1, balanceRaw: "5" }]);
  badDifference.source.supplyDifferenceRaw = "994";
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityConcentration(badDifference), /supply difference/);
});

test("preserves Step 5B-2 provenance and source coverage", () => {
  const input = evidence([{ seed: 1, balanceRaw: "5" }], {
    supply: "100", holderSnapshotId: `sha256:${"b".repeat(64)}`,
    unsupportedExtensionTypes: [4],
  });
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(input);
  assert.equal(result.policyVersion, input.policyVersion);
  assert.equal(result.source.populationSchemaVersion, INPUT_VERSION);
  assert.equal(result.source.holderSnapshotId, input.source.holderSnapshotId);
  assert.equal(result.source.exclusionAssessmentSchemaVersion, ASSESSMENT_VERSION);
  assert.equal(result.source.holderFetchedAt, FETCHED_AT);
  assert.deepEqual(result.source.amountCoverage, input.source.amountCoverage);
  assert.deepEqual(result.source.enumeration, input.source.enumeration);
  assert.equal(result.source.holderSupplyAlignment, "not_proven_atomic");
});

test("mutating output does not mutate input and later input mutation does not mutate output", () => {
  const input = evidence([{ seed: 1, balanceRaw: "5" }], { supply: "100" });
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(input);
  result.source.enumeration.contextSlots[0] = 999;
  result.source.amountCoverage.unsupportedExtensionTypes.push(42);
  result.population.byDecision.retain.subjectCount = 99;
  assert.deepEqual(input.source.enumeration.contextSlots, [700, 701]);
  assert.deepEqual(input.source.amountCoverage.unsupportedExtensionTypes, []);
  assert.equal(input.byDecision.retain.subjectCount, 1);

  const resultAfterInputMutation = deriveSolanaNotExcludedOwnerAuthorityConcentration(input);
  input.source.enumeration.contextSlots[0] = 1234;
  input.source.amountCoverage.unsupportedExtensionTypes.push(7);
  input.subjects[0].balanceRaw = "99";
  assert.deepEqual(resultAfterInputMutation.source.enumeration.contextSlots, [700, 701]);
  assert.deepEqual(resultAfterInputMutation.source.amountCoverage.unsupportedExtensionTypes, []);
  assert.equal(resultAfterInputMutation.notExcludedObservedPopulationTopNShare.top1.numeratorRaw, "5");
});

test("does not import providers or expose scoring/AI/global concentration behavior", () => {
  const source = fs.readFileSync("src/normalization/solanaNotExcludedOwnerAuthorityConcentration.ts", "utf8");
  assert.doesNotMatch(source, /providers[\\/]|fetch\s*\(|score|qualification|\bAI\b/i);
  const result = deriveSolanaNotExcludedOwnerAuthorityConcentration(evidence([{ seed: 1, balanceRaw: "5" }]));
  assert.equal(result.chain, "solana");
  assert.equal("adjustedConcentration" in result, false);
});
