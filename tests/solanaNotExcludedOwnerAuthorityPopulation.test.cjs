const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSolanaHolderSnapshotRecord, createSolanaHolderSnapshotRecordV2 } = require("../dist/normalization/solanaHolderSnapshotComparison.js");
const { deriveSolanaAddressRoleEvidence } = require("../dist/normalization/solanaAddressRoleEvidence.js");
const { deriveSolanaAddressRoleEvidenceV2 } = require("../dist/normalization/solanaAddressRoleEvidence.js");
const { assessSolanaHolderExclusions } = require("../dist/normalization/solanaHolderExclusionAssessment.js");
const { assessSolanaHolderExclusionsV2 } = require("../dist/normalization/solanaHolderExclusionAssessment.js");
const { normalizeMarketSnapshot } = require("../dist/normalization/marketSnapshot.js");
const { deriveSolanaNotExcludedOwnerAuthorityPopulation } = require("../dist/normalization/solanaNotExcludedOwnerAuthorityPopulation.js");
const { deriveSolanaNotExcludedOwnerAuthorityPopulationV2 } = require("../dist/normalization/solanaNotExcludedOwnerAuthorityPopulation.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const MINT = "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP";
const COUNTER = "11111111111111111111111111111111";
const FETCHED_AT = "2026-10-07T12:00:00.000Z";
const MARKET_AT = "2026-10-07T12:01:00.000Z";
function key(seed) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 28);
  return encodeSolanaPublicKey(bytes);
}
const OWNER_A = key(4);
const OWNER_B = key(5);
const OWNER_C = key(6);
const AUTHORITY = OWNER_A;

function formatPercent(numeratorRaw, denominatorRaw) {
  const numerator = BigInt(numeratorRaw);
  const denominator = BigInt(denominatorRaw);
  const scaled = (numerator * 100n * 1_000_000n + denominator / 2n) / denominator;
  return `${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, "0")}`;
}

function holderStructure(options = {}) {
  const balances = options.balances ?? [[OWNER_A, "100"], [OWNER_B, "20"], [OWNER_C, "5"]];
  const supply = options.supply ?? "1000";
  const sorted = balances.map(([ownerAddress, balanceRaw]) => ({ ownerAddress, balanceRaw, tokenAccountCount: 1 }))
    .sort((left, right) => BigInt(left.balanceRaw) > BigInt(right.balanceRaw) ? -1
      : BigInt(left.balanceRaw) < BigInt(right.balanceRaw) ? 1
        : left.ownerAddress < right.ownerAddress ? -1 : left.ownerAddress > right.ownerAddress ? 1 : 0);
  const total = sorted.reduce((sum, owner) => sum + BigInt(owner.balanceRaw), 0n);
  const extensions = [...(options.extensions ?? [])].sort((a, b) => a - b);
  const supplyInconsistent = total > BigInt(supply);
  const partial = extensions.length > 0 || supplyInconsistent;
  const reason = supplyInconsistent ? "supply_inconsistency"
    : extensions.length > 0 ? "unsupported_balance_affecting_extension" : null;
  const makeConcentration = (n) => {
    const numerator = sorted.slice(0, n).reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n);
    if (supply === "0" || supplyInconsistent) {
      return { status: "unavailable", topN: n, numeratorRaw: null, denominatorRaw: supply,
        denominatorBasis: "current_mint_supply", percentage: null,
        reason: supplyInconsistent ? "supply_inconsistency" : "zero_supply" };
    }
    if (partial && extensions.length === 0) throw new Error("fixture has unsupported partial coverage");
    return { status: "available", topN: n, numeratorRaw: numerator.toString(), denominatorRaw: supply,
      denominatorBasis: "current_mint_supply", percentage: formatPercent(numerator.toString(), supply) };
  };
  return {
    chain: "solana", mintAddress: options.mintAddress ?? MINT, tokenProgram: "spl-token", decimals: 6,
    currentMintSupplyRaw: supply, observedPositiveBalanceRaw: total.toString(),
    supplyDifferenceRaw: (BigInt(supply) - total).toString(), fetchedAt: options.fetchedAt ?? FETCHED_AT,
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [700, 701] },
    tokenAccountCount: sorted.length, nonzeroTokenAccountCount: sorted.length,
    tokenAccountStateSummary: {
      initialized: { tokenAccountCount: sorted.length, positiveBalanceTokenAccountCount: sorted.length, observedBalanceRaw: total.toString() },
      frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
    },
    rawOwnerCount: sorted.length, rawOwnerAuthorities: sorted,
    amountCoverage: { state: partial ? "partial" : "complete", unsupportedExtensionTypes: extensions, reason },
    concentration: { top1: makeConcentration(1), top5: makeConcentration(5), top10: makeConcentration(10), top20: makeConcentration(20) },
  };
}

function assessmentFor(holder, { mintAuthority = AUTHORITY, freezeAuthority = null } = {}) {
  const resolution = {
    exists: true, isMint: true, mintAddress: holder.mintAddress, tokenProgram: "spl-token", decimals: 6,
    rawSupply: holder.currentMintSupplyRaw,
    baseAuthorities: {
      mintAuthority: mintAuthority === null ? { status: "unset", address: null } : { status: "set", address: mintAuthority },
      freezeAuthority: freezeAuthority === null ? { status: "unset", address: null } : { status: "set", address: freezeAuthority },
    },
  };
  const market = normalizeMarketSnapshot("solana", holder.mintAddress, [], MARKET_AT);
  const roleEvidence = deriveSolanaAddressRoleEvidence(resolution, holder, { status: "available", snapshot: market });
  return assessSolanaHolderExclusions({ holderStructure: holder, addressRoleEvidence: roleEvidence });
}

function derive(holder = holderStructure(), assessment = assessmentFor(holder)) {
  return deriveSolanaNotExcludedOwnerAuthorityPopulation(createSolanaHolderSnapshotRecord(holder), assessment);
}

function snapshotV2(holder, partial = false) {
  const value = structuredClone(holder);
  if (partial) {
    value.enumeration.completeness = "partial";
    value.concentration = Object.fromEntries([1, 5, 10, 20].map((n) => ["top" + n, {
      status: "unavailable", topN: n, numeratorRaw: null, denominatorRaw: value.currentMintSupplyRaw,
      denominatorBasis: "current_mint_supply", percentage: null, reason: "enumeration_incomplete",
    }]));
    value.acquisition = { stopReason: "request_timeout", configuredMaxPages: 20, requestedPageSize: 5000 };
    return createSolanaHolderSnapshotRecordV2(value);
  }
  return createSolanaHolderSnapshotRecordV2(value, { completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20, requestedPageSize: 5000 });
}

function assessV2(holder, partial = false) {
  const record = snapshotV2(holder, partial);
  const resolution = {
    exists: true, isMint: true, mintAddress: holder.mintAddress, tokenProgram: holder.tokenProgram,
    decimals: holder.decimals, rawSupply: holder.currentMintSupplyRaw,
    baseAuthorities: { mintAuthority: { status: "set", address: OWNER_A }, freezeAuthority: { status: "unset", address: null } },
  };
  const roles = deriveSolanaAddressRoleEvidenceV2(resolution, record, {
    status: "available", snapshot: normalizeMarketSnapshot("solana", holder.mintAddress, [], MARKET_AT),
  });
  return { record, assessment: assessSolanaHolderExclusionsV2({ holderSnapshot: record, addressRoleEvidence: roles }) };
}

test("valid current-policy population partitions raw rows and includes retain and unresolved", () => {
  const holder = holderStructure();
  const result = derive(holder);
  assert.equal(result.schemaVersion, "solana-not-excluded-owner-authority-population-v1");
  assert.deepEqual(result.raw, { subjectCount: 3, observedPositiveBalanceRaw: "125" });
  assert.deepEqual(result.byDecision, {
    exclude: { subjectCount: 0, observedBalanceRaw: "0" },
    retain: { subjectCount: 2, observedBalanceRaw: "25" },
    unresolved: { subjectCount: 1, observedBalanceRaw: "100" },
  });
  assert.deepEqual(result.notExcluded, { subjectCount: 3, observedBalanceRaw: "125" });
  assert.equal(result.reconciliation.basis, "decision_categories_partition_observed_positive_owner_authority_rows");
});

test("V2 complete population matches V1 membership and balance partition", () => {
  const holder = holderStructure();
  const { record, assessment } = assessV2(holder);
  const v1 = derive(holder);
  const v2 = deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, assessment);
  assert.equal(v2.schemaVersion, "solana-not-excluded-owner-authority-population-v2");
  assert.equal(v2.frame, "observed_assessed_positive_owner_authorities");
  assert.deepEqual(v2.subjects, v1.subjects);
  assert.deepEqual(v2.byDecision, v1.byDecision);
  assert.deepEqual(v2.notExcluded, v1.notExcluded);
  assert.equal(v2.source.holderSnapshotId, record.snapshotId);
});

test("V2 partial population preserves exact observed rows and partial acquisition provenance", () => {
  const holder = holderStructure({ balances: [[OWNER_A, "100"], [OWNER_B, "20"]] });
  const { record, assessment } = assessV2(holder, true);
  const v2 = deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, assessment);
  assert.equal(v2.source.enumeration.completeness, "partial");
  assert.equal(v2.source.acquisition.stopReason, "request_timeout");
  assert.equal(v2.raw.observedPositiveBalanceRaw, "120");
  assert.deepEqual(v2.subjects.map((row) => row.subjectAddress), [OWNER_A, OWNER_B].sort());
  assert.equal(v2.notExcluded.observedBalanceRaw, "120");
});

test("V2 rejects a forged exclusion and mismatched source snapshot ID", () => {
  const { record, assessment } = assessV2(holderStructure());
  const forged = structuredClone(assessment);
  forged.subjects[0].decision = "exclude";
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, forged));
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, { ...assessment, sourceEvidence: { ...assessment.sourceEvidence, holderSnapshotId: "sha256:" + "f".repeat(64) } }));
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, { ...assessment, policyVersion: "other-policy" }));
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, { ...assessment, subjects: assessment.subjects.slice(1) }));
  const changedBalance = structuredClone(assessment);
  changedBalance.subjects[0].balanceRaw = "999";
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, changedBalance));
  assert.throws(() => deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, assess(holderStructure())));
});

test("V2 output and validation do not mutate the snapshot or assessment inputs", () => {
  const { record, assessment } = assessV2(holderStructure(), true);
  const beforeRecord = structuredClone(record);
  const beforeAssessment = structuredClone(assessment);
  const result = deriveSolanaNotExcludedOwnerAuthorityPopulationV2(record, assessment);
  assert.deepEqual(record, beforeRecord);
  assert.deepEqual(assessment, beforeAssessment);
  result.subjects[0].balanceRaw = "777";
  assert.deepEqual(record, beforeRecord);
  assert.deepEqual(assessment, beforeAssessment);
});

test("retain remains included in notExcluded", () => {
  const holder = holderStructure({ balances: [[OWNER_B, "20"]] });
  const result = derive(holder, assessmentFor(holder, { mintAuthority: null }));
  assert.deepEqual(result.notExcluded, { subjectCount: 1, observedBalanceRaw: "20" });
  assert.equal(result.subjects[0].decision, "retain");
});

test("unresolved remains included in notExcluded without being relabeled", () => {
  const holder = holderStructure({ balances: [[OWNER_A, "20"]] });
  const result = derive(holder);
  assert.equal(result.subjects[0].decision, "unresolved");
  assert.deepEqual(result.notExcluded, { subjectCount: 1, observedBalanceRaw: "20" });
});

test("current policy emits zero exclusions and a forged current-policy exclusion is rejected", () => {
  const holder = holderStructure({ balances: [[OWNER_A, "20"]] });
  const assessment = assessmentFor(holder);
  assert.equal(assessment.summary.excludeCount, 0);
  assessment.subjects[0].decision = "exclude";
  assessment.summary.excludeCount = 1;
  assert.throws(() => derive(holder, assessment), /rule outcome|aggregate decision|cannot produce exclude/);
});

test("rejects assessment mint mismatch", () => {
  const holder = holderStructure();
  const assessment = assessmentFor(holder);
  assessment.mintAddress = COUNTER;
  assert.throws(() => derive(holder, assessment), /schema, identity, or policy/);
});

test("rejects snapshot and capture metadata mismatch", () => {
  const original = holderStructure();
  const assessment = assessmentFor(original);
  const changed = holderStructure({ fetchedAt: "2026-10-08T12:00:00.000Z" });
  assert.throws(() => derive(changed, assessment), /source metadata/);
});

test("rejects a missing assessment subject", () => {
  const holder = holderStructure();
  const assessment = assessmentFor(holder);
  assessment.subjects.pop();
  assert.throws(() => derive(holder, assessment), /omits a positive holder subject/);
});

test("rejects an extra assessment subject", () => {
  const holder = holderStructure({ balances: [[OWNER_A, "20"]] });
  const assessment = assessmentFor(holder);
  const extra = structuredClone(assessment.subjects[0]);
  extra.subjectAddress = key(99);
  assessment.subjects.push(extra);
  assert.throws(() => derive(holder, assessment), /subject set or balance/);
});

test("rejects duplicate assessment subjects", () => {
  const holder = holderStructure({ balances: [[OWNER_A, "20"]] });
  const assessment = assessmentFor(holder);
  assessment.subjects.push(structuredClone(assessment.subjects[0]));
  assert.throws(() => derive(holder, assessment), /subject set or balance/);
});

test("rejects exact balance mismatch", () => {
  const holder = holderStructure({ balances: [[OWNER_A, "20"]] });
  const assessment = assessmentFor(holder);
  assessment.subjects[0].balanceRaw = "21";
  assert.throws(() => derive(holder, assessment), /subject set or balance/);
});

test("rejects malformed and nonpositive assessment balances", () => {
  const holder = holderStructure({ balances: [[OWNER_A, "20"]] });
  for (const value of ["0", "-1", "01", "1.0", " 1"]) {
    const assessment = assessmentFor(holder);
    assessment.subjects[0].balanceRaw = value;
    assert.throws(() => derive(holder, assessment), /subject set or balance/);
  }
});

test("rejects an inconsistent assessment decision summary", () => {
  const holder = holderStructure();
  const assessment = assessmentFor(holder);
  assessment.summary.retainCount += 1;
  assert.throws(() => derive(holder, assessment), /summary does not reconcile/);
});

test("rejects an aggregate decision inconsistent with its rule outcomes", () => {
  const holder = holderStructure({ balances: [[OWNER_A, "20"]] });
  const assessment = assessmentFor(holder);
  assessment.subjects[0].decision = "retain";
  assert.throws(() => derive(holder, assessment), /aggregate decision contradicts/);
});

test("subject output ordering is canonical and independent of assessment array order", () => {
  const holder = holderStructure();
  const assessment = assessmentFor(holder);
  assessment.subjects.reverse();
  const first = derive(holder, assessment);
  const second = derive(holder, assessment);
  assert.deepEqual(first.subjects.map((row) => row.subjectAddress), [...first.subjects.map((row) => row.subjectAddress)].sort());
  assert.deepEqual(first, second);
});

test("valid empty population has exact zero partition totals", () => {
  const holder = holderStructure({ balances: [] });
  const result = derive(holder, assessmentFor(holder));
  assert.deepEqual(result.raw, { subjectCount: 0, observedPositiveBalanceRaw: "0" });
  assert.deepEqual(result.byDecision, {
    exclude: { subjectCount: 0, observedBalanceRaw: "0" },
    retain: { subjectCount: 0, observedBalanceRaw: "0" },
    unresolved: { subjectCount: 0, observedBalanceRaw: "0" },
  });
  assert.deepEqual(result.notExcluded, { subjectCount: 0, observedBalanceRaw: "0" });
});

test("partial amount coverage remains usable and is preserved without upgrading", () => {
  const holder = holderStructure({ extensions: [1] });
  const result = derive(holder);
  assert.equal(result.source.amountCoverage.state, "partial");
  assert.equal(result.source.amountCoverage.reason, "unsupported_balance_affecting_extension");
  assert.deepEqual(result.source.amountCoverage.unsupportedExtensionTypes, [1]);
  assert.equal(result.reconciliation.status, "reconciled");
});

test("negative supply difference remains usable as observed-row partition evidence", () => {
  const holder = holderStructure({ balances: [[OWNER_A, "70"], [OWNER_B, "50"]], supply: "100" });
  const result = derive(holder);
  assert.equal(result.source.supplyDifferenceRaw, "-20");
  assert.equal(result.source.amountCoverage.reason, "supply_inconsistency");
  assert.equal(result.raw.observedPositiveBalanceRaw, "120");
  assert.equal(result.notExcluded.observedBalanceRaw, "120");
});

test("balances above Number.MAX_SAFE_INTEGER retain exact BigInt partition arithmetic", () => {
  const holder = holderStructure({
    balances: [[OWNER_A, "9007199254740993"], [OWNER_B, "8000000000000000"]],
    supply: "18000000000000000",
  });
  const result = derive(holder, assessmentFor(holder, { mintAuthority: null }));
  assert.equal(result.raw.observedPositiveBalanceRaw, "17007199254740993");
  assert.equal(result.notExcluded.observedBalanceRaw, "17007199254740993");
  assert.equal(result.byDecision.retain.observedBalanceRaw, "17007199254740993");
});

test("mutating output does not mutate the snapshot or assessment inputs", () => {
  const holder = holderStructure();
  const record = createSolanaHolderSnapshotRecord(holder);
  const assessment = assessmentFor(holder);
  const result = deriveSolanaNotExcludedOwnerAuthorityPopulation(record, assessment);
  result.source.enumeration.contextSlots[0] = 999;
  result.source.amountCoverage.unsupportedExtensionTypes.push(24);
  result.subjects[0].balanceRaw = "999";
  assert.deepEqual(record.snapshot.enumeration.contextSlots, [700, 701]);
  assert.deepEqual(record.snapshot.amountCoverage.unsupportedExtensionTypes, []);
  assert.equal(assessment.subjects[0].balanceRaw, "100");
});

test("mutating assessment input after derivation does not mutate output", () => {
  const holder = holderStructure();
  const assessment = assessmentFor(holder);
  const result = derive(holder, assessment);
  assessment.subjects[0].balanceRaw = "999";
  assessment.sourceEvidence.holderEnumeration.contextSlots[0] = 1234;
  assert.equal(result.subjects.find((row) => row.subjectAddress === OWNER_A).balanceRaw, "100");
  assert.deepEqual(result.source.enumeration.contextSlots, [700, 701]);
});

test("preserves the consumed snapshot ID and assessment/source versions", () => {
  const holder = holderStructure();
  const record = createSolanaHolderSnapshotRecord(holder);
  const result = deriveSolanaNotExcludedOwnerAuthorityPopulation(record, assessmentFor(holder));
  assert.equal(result.source.holderSnapshotId, record.snapshotId);
  assert.equal(result.source.exclusionAssessmentSchemaVersion, "solana-holder-exclusion-assessment-v1");
  assert.equal(result.policyVersion, "solana-address-exclusion-policy-v1");
});
