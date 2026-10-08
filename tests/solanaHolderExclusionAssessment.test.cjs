const assert = require("node:assert/strict");
const { test } = require("node:test");
const { assessSolanaHolderExclusions, SOLANA_ADDRESS_EXCLUSION_POLICY_VERSION } = require("../dist/normalization/solanaHolderExclusionAssessment.js");
const { deriveSolanaAddressRoleEvidence } = require("../dist/normalization/solanaAddressRoleEvidence.js");
const { normalizeMarketSnapshot } = require("../dist/normalization/marketSnapshot.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const MINT = "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP";
const FETCHED_AT = "2026-10-07T12:00:00.000Z";
const MARKET_AT = "2026-10-07T12:01:00.000Z";

function key(seed) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 28);
  return encodeSolanaPublicKey(bytes);
}

const MINT_AUTHORITY = key(1);
const FREEZE_AUTHORITY = key(2);
const POOL = key(3);
const OWNER_A = key(4);
const OWNER_B = key(5);
const OWNER_C = key(6);
const COUNTER = "11111111111111111111111111111111";

function mintResolution({ mintAuthority = MINT_AUTHORITY, freezeAuthority = FREEZE_AUTHORITY } = {}) {
  return {
    exists: true,
    isMint: true,
    mintAddress: MINT,
    tokenProgram: "spl-token",
    decimals: 6,
    rawSupply: "1000",
    baseAuthorities: {
      mintAuthority: mintAuthority === null ? { status: "unset", address: null } : { status: "set", address: mintAuthority },
      freezeAuthority: freezeAuthority === null ? { status: "unset", address: null } : { status: "set", address: freezeAuthority },
    },
  };
}

function holderStructure(addresses = [OWNER_A, OWNER_B, OWNER_C]) {
  const rawOwnerAuthorities = addresses.map((ownerAddress, index) => ({
    ownerAddress,
    balanceRaw: String(3 - index),
    tokenAccountCount: 1,
  }));
  const observed = rawOwnerAuthorities.reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n);
  return {
    chain: "solana",
    mintAddress: MINT,
    tokenProgram: "spl-token",
    decimals: 6,
    currentMintSupplyRaw: "1000",
    observedPositiveBalanceRaw: observed.toString(),
    supplyDifferenceRaw: (1000n - observed).toString(),
    fetchedAt: FETCHED_AT,
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [700, 701] },
    tokenAccountCount: addresses.length,
    nonzeroTokenAccountCount: addresses.length,
    tokenAccountStateSummary: {
      initialized: { tokenAccountCount: addresses.length, positiveBalanceTokenAccountCount: addresses.length, observedBalanceRaw: observed.toString() },
      frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
    },
    rawOwnerCount: addresses.length,
    rawOwnerAuthorities,
    amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null },
    concentration: {
      top1: { status: "available", topN: 1, numeratorRaw: "3", denominatorRaw: "1000", denominatorBasis: "current_mint_supply", percentage: "0.300000" },
      top5: { status: "available", topN: 5, numeratorRaw: "6", denominatorRaw: "1000", denominatorBasis: "current_mint_supply", percentage: "0.600000" },
      top10: { status: "available", topN: 10, numeratorRaw: "6", denominatorRaw: "1000", denominatorBasis: "current_mint_supply", percentage: "0.600000" },
      top20: { status: "available", topN: 20, numeratorRaw: "6", denominatorRaw: "1000", denominatorBasis: "current_mint_supply", percentage: "0.600000" },
    },
  };
}

function rawPool(poolAddress = POOL, dexId = "test-dex") {
  return {
    chainId: "solana", poolAddress, dexId, baseTokenAddress: MINT, quoteTokenAddress: COUNTER,
    priceUsd: "1", marketCapUsd: "1000", fdvUsd: "1000", liquidityUsd: 10,
    volumeUsd: { h24: 20 }, poolCreatedAt: null,
  };
}

function roleEvidence({ holder = holderStructure(), resolution = mintResolution(), market } = {}) {
  const pools = market === undefined ? [rawPool()] : market;
  const snapshot = normalizeMarketSnapshot("solana", MINT, pools, MARKET_AT);
  return deriveSolanaAddressRoleEvidence(resolution, holder, { status: "available", snapshot });
}

function assess({ holder = holderStructure(), evidence = roleEvidence({ holder }) } = {}) {
  return assessSolanaHolderExclusions({ holderStructure: holder, addressRoleEvidence: evidence });
}

function subject(result, address) {
  const found = result.subjects.find((row) => row.subjectAddress === address);
  assert.ok(found, `missing assessed subject ${address}`);
  return found;
}

test("the v1 policy produces zero automatic exclusions", () => {
  const result = assess();
  assert.equal(result.policyVersion, SOLANA_ADDRESS_EXCLUSION_POLICY_VERSION);
  assert.equal(result.summary.excludeCount, 0);
  assert.equal(result.subjects.some((row) => row.decision === "exclude"), false);
});

test("a mint-authority match is unresolved with insufficient evidence", () => {
  const holder = holderStructure([MINT_AUTHORITY]);
  const row = subject(assess({ holder, evidence: roleEvidence({ holder }) }), MINT_AUTHORITY);
  assert.deepEqual([row.ruleAssessments[0].decision, row.ruleAssessments[0].evidenceSufficiency, row.ruleAssessments[0].reasonCode], ["unresolved", "insufficient", "matched_role_requires_more_evidence"]);
});

test("a freeze-authority match is unresolved with insufficient evidence", () => {
  const holder = holderStructure([FREEZE_AUTHORITY]);
  const row = subject(assess({ holder, evidence: roleEvidence({ holder }) }), FREEZE_AUTHORITY);
  assert.deepEqual([row.ruleAssessments[1].decision, row.ruleAssessments[1].evidenceSufficiency], ["unresolved", "insufficient"]);
});

test("a DEX pool-address match is unresolved with insufficient evidence", () => {
  const holder = holderStructure([POOL]);
  const row = subject(assess({ holder, evidence: roleEvidence({ holder }) }), POOL);
  assert.deepEqual([row.ruleAssessments[2].decision, row.ruleAssessments[2].evidenceSufficiency], ["unresolved", "insufficient"]);
});

test("multiple matched roles remain independently insufficient and aggregate unresolved", () => {
  const holder = holderStructure([POOL]);
  const evidence = roleEvidence({ holder, resolution: mintResolution({ mintAuthority: POOL, freezeAuthority: POOL }) });
  const row = subject(assess({ holder, evidence }), POOL);
  assert.deepEqual(row.ruleAssessments.map((item) => item.evidenceSufficiency), ["insufficient", "insufficient", "insufficient"]);
  assert.deepEqual(row.ruleAssessments.map((item) => item.decision), ["unresolved", "unresolved", "unresolved"]);
  assert.equal(row.decision, "unresolved");
});

test("clean no-match is narrowly retained as not excluded by this policy", () => {
  const holder = holderStructure([OWNER_A]);
  const row = subject(assess({ holder, evidence: roleEvidence({ holder, resolution: mintResolution({ mintAuthority: null, freezeAuthority: null }), market: [] }) }), OWNER_A);
  assert.deepEqual(row.ruleAssessments.map((item) => [item.decision, item.reasonCode]), [
    ["retain", "no_supported_exclusion_rule_matched"],
    ["retain", "no_supported_exclusion_rule_matched"],
    ["retain", "no_supported_exclusion_rule_matched"],
  ]);
});

test("rejects a DEX no-match count below the valid supplied pool-address evidence", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  assert.equal(evidence.marketSource.validPoolAddressCount, 1);
  evidence.ownerAuthorities[0].findings[2].examinedPoolCount = 0;
  assert.throws(() => assess({ holder, evidence }), /no-match is not supported/);
});

test("rejects a DEX no-match count above the valid supplied pool-address evidence", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  evidence.ownerAuthorities[0].findings[2].examinedPoolCount = 2;
  assert.throws(() => assess({ holder, evidence }), /no-match is not supported/);
});

test("unavailable DEX evidence is unresolved and cannot exclude", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = deriveSolanaAddressRoleEvidence(mintResolution(), holder, {
    status: "unavailable", provider: "dexscreener", reason: "provider_error",
  });
  const row = subject(assess({ holder, evidence }), OWNER_A);
  assert.deepEqual([row.ruleAssessments[2].decision, row.ruleAssessments[2].evidenceSufficiency, row.ruleAssessments[2].reasonCode], ["unresolved", "insufficient", "market_evidence_unavailable"]);
  assert.equal(resultHasExclude(assess({ holder, evidence })), false);
});

test("rejects an unknown Step 5A market-unavailable reason", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = deriveSolanaAddressRoleEvidence(mintResolution(), holder, {
    status: "unavailable", provider: "dexscreener", reason: "provider_error",
  });
  evidence.marketSource.reason = "unexpected_reason";
  assert.throws(() => assess({ holder, evidence }), /unavailable market source is malformed/);
});

test("rejects inconsistent available market-source counts", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  evidence.marketSource.poolCount = 2;
  assert.throws(() => assess({ holder, evidence }), /available market source is malformed/);
});

test("rejects a supplied-pool validation state inconsistent with its counts", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  evidence.marketSource.suppliedPoolAddressValidation = "invalid_present";
  assert.throws(() => assess({ holder, evidence }), /available market source is malformed/);
});

test("requires market snapshot and finding provenance to match", () => {
  const holder = holderStructure([OWNER_A]);
  const mismatchedSource = roleEvidence({ holder });
  mismatchedSource.marketSource.snapshotAt = "2026-10-07T12:02:00.000Z";
  assert.throws(() => assess({ holder, evidence: mismatchedSource }), /available market source is malformed/);

  const mismatchedFinding = roleEvidence({ holder });
  mismatchedFinding.ownerAuthorities[0].findings[2].provenance.fetchedAt = "2026-10-07T12:02:00.000Z";
  assert.throws(() => assess({ holder, evidence: mismatchedFinding }), /no-match is not supported/);
});

function resultHasExclude(result) {
  return result.subjects.some((row) => row.decision === "exclude");
}

test("malformed supplied pool addresses remain unresolved rather than becoming clean no-match", () => {
  const holder = holderStructure([OWNER_A]);
  const normalized = normalizeMarketSnapshot("solana", MINT, [rawPool()], MARKET_AT);
  normalized.pools[0].poolAddress = "not-a-public-key";
  const evidence = deriveSolanaAddressRoleEvidence(mintResolution(), holder, { status: "available", snapshot: normalized });
  const row = subject(assess({ holder, evidence }), OWNER_A);
  assert.deepEqual([row.ruleAssessments[2].decision, row.ruleAssessments[2].reasonCode], ["unresolved", "market_evidence_malformed_or_incomplete"]);
  assert.equal(row.ruleAssessments[0].decision, "retain");
});

test("conflicting DEX identity remains unresolved with conflicting sufficiency", () => {
  const holder = holderStructure([POOL]);
  const base = roleEvidence({ holder });
  const conflicting = structuredClone(base);
  conflicting.ownerAuthorities[0].findings[2] = {
    role: "dexscreener_reported_pool_address", status: "ambiguous", ownerAuthorityAddress: POOL,
    poolAddress: POOL, conflictingDexIds: ["dex-a", "dex-b"],
    provenance: { provider: "dexscreener", fetchedAt: MARKET_AT, sourceUpdatedAt: null },
  };
  conflicting.marketSource.conflictingPoolAddresses = [POOL];
  const row = subject(assess({ holder, evidence: conflicting }), POOL);
  assert.deepEqual([row.ruleAssessments[2].decision, row.ruleAssessments[2].evidenceSufficiency, row.ruleAssessments[2].reasonCode], ["unresolved", "conflicting", "conflicting_market_evidence"]);
});

test("unavailable DEX evidence does not erase independently usable authority findings", () => {
  const holder = holderStructure([MINT_AUTHORITY]);
  const evidence = deriveSolanaAddressRoleEvidence(mintResolution(), holder, {
    status: "unavailable", provider: "dexscreener", reason: "provider_error",
  });
  const row = subject(assess({ holder, evidence }), MINT_AUTHORITY);
  assert.equal(row.ruleAssessments[0].decision, "unresolved");
  assert.deepEqual([row.ruleAssessments[1].decision, row.ruleAssessments[1].evidenceSufficiency], ["retain", "sufficient"]);
  assert.equal(row.ruleAssessments[2].decision, "unresolved");
  assert.equal(row.ruleAssessments[0].reasonCode, "matched_role_requires_more_evidence");
  assert.equal(row.ruleAssessments[2].reasonCode, "market_evidence_unavailable");
});

test("rejects cross-mint role evidence", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  evidence.mintAddress = key(99);
  assert.throws(() => assess({ holder, evidence }), /incompatible chain, mint, or source identity/);
});

test("rejects Step 5A evidence from a different holder capture with matching subjects", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  evidence.holderSource.amountCoverage = {
    state: "partial",
    unsupportedExtensionTypes: [2],
    reason: "unsupported_balance_affecting_extension",
  };
  assert.throws(() => assess({ holder, evidence }), /incompatible chain, mint, or source identity/);
});

test("rejects a missing or extra subject rather than silently composing a different population", () => {
  const holder = holderStructure([OWNER_A, OWNER_B]);
  const evidence = roleEvidence({ holder });
  evidence.ownerAuthorities.pop();
  assert.throws(() => assess({ holder, evidence }), /subject set does not exactly match/);
});

test("rejects duplicate and malformed subject evidence", () => {
  const holder = holderStructure([OWNER_A]);
  const duplicate = roleEvidence({ holder });
  duplicate.ownerAuthorities.push(structuredClone(duplicate.ownerAuthorities[0]));
  assert.throws(() => assess({ holder, evidence: duplicate }), /subject set is malformed/);
  const malformed = roleEvidence({ holder });
  malformed.ownerAuthorities[0].ownerAuthorityAddress = "not-a-public-key";
  assert.throws(() => assess({ holder, evidence: malformed }), /subject set is malformed/);
});

test("assessment output sorts subjects and is independent of input subject ordering", () => {
  const holder = holderStructure([OWNER_C, OWNER_A, OWNER_B]);
  const evidence = roleEvidence({ holder });
  const first = assess({ holder, evidence });
  const reorderedEvidence = structuredClone(evidence);
  reorderedEvidence.ownerAuthorities.reverse();
  const second = assess({ holder, evidence: reorderedEvidence });
  assert.deepEqual(first.subjects.map((row) => row.subjectAddress), [OWNER_A, OWNER_B, OWNER_C].sort());
  assert.deepEqual(second, first);
});

test("assessment does not mutate holder or role evidence", () => {
  const holder = holderStructure([MINT_AUTHORITY, POOL]);
  const evidence = roleEvidence({ holder, resolution: mintResolution({ mintAuthority: POOL }) });
  const holderBefore = structuredClone(holder);
  const evidenceBefore = structuredClone(evidence);
  assess({ holder, evidence });
  assert.deepEqual(holder, holderBefore);
  assert.deepEqual(evidence, evidenceBefore);
});

test("assessment deeply separates nested evidence in both mutation directions", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  const holderBefore = structuredClone(holder);
  const evidenceBefore = structuredClone(evidence);
  const output = assess({ holder, evidence });
  const outputBefore = structuredClone(output);

  output.sourceEvidence.holderEnumeration.contextSlots[0] = 999;
  output.sourceEvidence.marketSource.invalidPoolAddresses.push("bad-address");
  output.subjects[0].ruleAssessments[2].finding.provenance.fetchedAt = "2026-10-07T12:09:00.000Z";
  assert.deepEqual(holder, holderBefore);
  assert.deepEqual(evidence, evidenceBefore);

  const separateOutput = assess({ holder, evidence });
  const separateOutputBefore = structuredClone(separateOutput);
  holder.enumeration.contextSlots[0] = 998;
  evidence.marketSource.conflictingPoolAddresses.push(POOL);
  evidence.ownerAuthorities[0].findings[2].provenance.sourceUpdatedAt = "2026-10-07T12:10:00.000Z";
  assert.deepEqual(separateOutput, separateOutputBefore);
  assert.deepEqual(outputBefore.subjects, separateOutputBefore.subjects);
});

test("preserves raw balance and concentration values without adjustment", () => {
  const holder = holderStructure([MINT_AUTHORITY, OWNER_A]);
  const before = structuredClone(holder);
  const result = assess({ holder, evidence: roleEvidence({ holder }) });
  assert.deepEqual(holder, before);
  assert.deepEqual(result.subjects.map((row) => row.balanceRaw), holder.rawOwnerAuthorities.map((row) => row.balanceRaw));
  assert.equal("adjustedConcentration" in result, false);
  assert.equal("adjustedBalanceRaw" in result.subjects[0], false);
});

test("policy version and identical inputs produce stable output", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  const first = assess({ holder, evidence });
  const second = assess({ holder, evidence });
  assert.equal(first.policyVersion, "solana-address-exclusion-policy-v1");
  assert.deepEqual(second, first);
});

test("rejects malformed positive holder rows before assessment", () => {
  const holder = holderStructure([OWNER_A]);
  holder.rawOwnerAuthorities[0].balanceRaw = "0";
  const evidence = roleEvidence({ holder: holderStructure([OWNER_A]) });
  assert.throws(() => assess({ holder, evidence }), /malformed or duplicate positive owner authorities/);
});

function setCoverage(holder, evidence, amountCoverage) {
  holder.amountCoverage = structuredClone(amountCoverage);
  evidence.holderSource.amountCoverage = structuredClone(amountCoverage);
}

test("rejects complete amount coverage with a non-null reason", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  setCoverage(holder, evidence, { state: "complete", unsupportedExtensionTypes: [], reason: "supply_inconsistency" });
  assert.throws(() => assess({ holder, evidence }), /Complete Solana amount coverage contradicts/);
});

test("rejects complete amount coverage with unsupported extension evidence", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  setCoverage(holder, evidence, { state: "complete", unsupportedExtensionTypes: [2], reason: null });
  assert.throws(() => assess({ holder, evidence }), /Complete Solana amount coverage contradicts/);
});

test("rejects partial unsupported-extension coverage without extension evidence", () => {
  const holder = holderStructure([OWNER_A]);
  const evidence = roleEvidence({ holder });
  setCoverage(holder, evidence, { state: "partial", unsupportedExtensionTypes: [], reason: "unsupported_balance_affecting_extension" });
  assert.throws(() => assess({ holder, evidence }), /Partial Solana amount coverage contradicts/);
});

test("rejects unsupported amount-coverage reasons and malformed extension entries", () => {
  const holderWithUnknownReason = holderStructure([OWNER_A]);
  const evidenceWithUnknownReason = roleEvidence({ holder: holderWithUnknownReason });
  setCoverage(holderWithUnknownReason, evidenceWithUnknownReason, {
    state: "partial", unsupportedExtensionTypes: [2], reason: "unknown_reason",
  });
  assert.throws(() => assess({ holder: holderWithUnknownReason, evidence: evidenceWithUnknownReason }), /unsupported reason/);

  const holderWithMalformedExtension = holderStructure([OWNER_A]);
  const evidenceWithMalformedExtension = roleEvidence({ holder: holderWithMalformedExtension });
  setCoverage(holderWithMalformedExtension, evidenceWithMalformedExtension, {
    state: "partial", unsupportedExtensionTypes: ["2"], reason: "unsupported_balance_affecting_extension",
  });
  assert.throws(() => assess({ holder: holderWithMalformedExtension, evidence: evidenceWithMalformedExtension }), /extension types are malformed/);
});

test("accepts valid partial amount coverage and supply-inconsistency semantics", () => {
  const extensionHolder = holderStructure([OWNER_A]);
  extensionHolder.amountCoverage = {
    state: "partial", unsupportedExtensionTypes: [2], reason: "unsupported_balance_affecting_extension",
  };
  const extensionEvidence = roleEvidence({ holder: extensionHolder });
  assert.doesNotThrow(() => assess({ holder: extensionHolder, evidence: extensionEvidence }));

  const inconsistentHolder = holderStructure([OWNER_A, OWNER_B, OWNER_C]);
  inconsistentHolder.currentMintSupplyRaw = "5";
  inconsistentHolder.supplyDifferenceRaw = "-1";
  inconsistentHolder.amountCoverage = { state: "partial", unsupportedExtensionTypes: [], reason: "supply_inconsistency" };
  const inconsistentEvidence = roleEvidence({ holder: inconsistentHolder });
  assert.doesNotThrow(() => assess({ holder: inconsistentHolder, evidence: inconsistentEvidence }));
});
