const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { composeSolanaHolderAssessment } = require("../dist/application/solanaHolderAssessment.js");
const { createSolanaHolderSnapshotRecordV2 } = require("../dist/normalization/solanaHolderSnapshotComparison.js");
const { normalizeMarketSnapshot } = require("../dist/normalization/marketSnapshot.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const key = seed => encodeSolanaPublicKey(Buffer.alloc(32, seed));
const MINT = key(1), OWNER = key(2), OTHER = key(3);
const TIME = "2026-10-07T12:00:00.000Z";

function fixture({ balances = ["50", "30"], supply = "100", partial = false } = {}) {
  const rows = balances.map((balanceRaw, i) => ({ ownerAddress: key(i + 2), balanceRaw, tokenAccountCount: 1 }));
  const total = rows.reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n);
  const inconsistent = total > BigInt(supply);
  const holder = {
    chain: "solana", mintAddress: MINT, tokenProgram: "spl-token", decimals: 6,
    currentMintSupplyRaw: supply, observedPositiveBalanceRaw: String(total), supplyDifferenceRaw: String(BigInt(supply) - total), fetchedAt: TIME,
    enumeration: { completeness: partial ? "partial" : "complete", slotConsistency: "not_guaranteed", pageCount: 1, contextSlots: [700] },
    tokenAccountCount: rows.length, nonzeroTokenAccountCount: rows.length,
    tokenAccountStateSummary: {
      initialized: { tokenAccountCount: rows.length, positiveBalanceTokenAccountCount: rows.length, observedBalanceRaw: String(total) },
      frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
    },
    rawOwnerCount: rows.length, rawOwnerAuthorities: rows,
    amountCoverage: { state: inconsistent ? "partial" : "complete", unsupportedExtensionTypes: [], reason: inconsistent ? "supply_inconsistency" : null },
    concentration: Object.fromEntries([1, 5, 10, 20].map(n => {
      const numerator = rows.slice(0, n).reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n);
      const reason = partial ? "enumeration_incomplete" : inconsistent ? "supply_inconsistency" : supply === "0" ? "zero_supply" : null;
      const scaled = reason ? 0n : (numerator * 100000000n + BigInt(supply) / 2n) / BigInt(supply);
      return ["top" + n, { status: reason ? "unavailable" : "available", topN: n, numeratorRaw: reason ? null : String(numerator),
        denominatorRaw: supply, denominatorBasis: "current_mint_supply", percentage: reason ? null : `${scaled / 1000000n}.${String(scaled % 1000000n).padStart(6, "0")}`, ...(reason ? { reason } : {}) }];
    })),
  };
  let holderSnapshot;
  if (partial) {
    holder.acquisition = { stopReason: "request_timeout", configuredMaxPages: 20, requestedPageSize: 5000 };
    holderSnapshot = createSolanaHolderSnapshotRecordV2(holder);
  } else {
    holderSnapshot = createSolanaHolderSnapshotRecordV2(holder, { completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20, requestedPageSize: 5000 });
  }
  return {
    mintResolution: { exists: true, isMint: true, mintAddress: MINT, tokenProgram: "spl-token", decimals: 6, rawSupply: supply,
      baseAuthorities: { mintAuthority: { status: "set", address: OWNER }, freezeAuthority: { status: "unset", address: null } } },
    holderSnapshot,
    marketInput: { status: "available", snapshot: normalizeMarketSnapshot("solana", MINT, [], TIME) },
  };
}

test("complete assessment reconciles stages without excluding unresolved authorities", () => {
  const input = fixture();
  const result = composeSolanaHolderAssessment(input);
  assert.equal(result.schemaVersion, "solana-holder-assessment-v1");
  assert.equal(result.exclusionAssessment.policyVersion, "solana-address-exclusion-policy-v1");
  assert.deepEqual(result.population.byDecision, {
    exclude: { subjectCount: 0, observedBalanceRaw: "0" },
    retain: { subjectCount: 1, observedBalanceRaw: "30" },
    unresolved: { subjectCount: 1, observedBalanceRaw: "50" },
  });
  assert.deepEqual(result.population.notExcluded, { subjectCount: 2, observedBalanceRaw: "80" });
  assert.equal(result.exclusionAssessment.sourceEvidence.holderSnapshotId, input.holderSnapshot.snapshotId);
  assert.equal(result.population.source.holderSnapshotId, input.holderSnapshot.snapshotId);
  assert.equal(result.concentration.source.holderSnapshotId, input.holderSnapshot.snapshotId);
  assert.equal(result.concentration.notExcludedTopNCurrentMintSupplyShare.top1.percentage, "50.000000");
  assert.equal(result.concentration.notExcludedObservedPopulationTopNShare.top1.percentage, "62.500000");
});

test("partial acquisition withholds global concentration and preserves observed-population limits", () => {
  const result = composeSolanaHolderAssessment(fixture({ partial: true }));
  assert.equal(result.population.source.acquisition.stopReason, "request_timeout");
  assert.equal(result.population.source.enumeration.completeness, "partial");
  assert.equal(result.concentration.notExcludedTopNCurrentMintSupplyShare.reason, "enumeration_incomplete");
  assert.equal(result.concentration.notExcludedTopNCurrentMintSupplyShare.top1.numeratorRaw, null);
  assert.equal(result.concentration.notExcludedObservedPopulationTopNShare.completeness, "partial");
  assert.deepEqual(result.concentration.notExcludedObservedPopulationTopNShare.partialReasons, ["enumeration_incomplete"]);
});

test("unavailable market evidence remains unresolved rather than ordinary or excluded", () => {
  const input = fixture();
  input.marketInput = { status: "unavailable", provider: "dexscreener", reason: "provider_error" };
  const result = composeSolanaHolderAssessment(input);
  assert.equal(result.addressRoleEvidence.marketSource.status, "unavailable");
  assert.equal(result.exclusionAssessment.summary.unresolvedCount, 2);
  assert.equal(result.exclusionAssessment.summary.excludeCount, 0);
  assert.equal(result.population.notExcluded.observedBalanceRaw, "80");
});

test("conflicting pool evidence remains conflicting and does not justify exclusion", () => {
  const input = fixture();
  const pool = { chainId: "solana", poolAddress: OTHER, baseTokenAddress: MINT, quoteTokenAddress: key(9),
    priceUsd: "1", marketCapUsd: "100", fdvUsd: "100", liquidityUsd: 10, volumeUsd: { h24: 20 }, poolCreatedAt: null };
  input.marketInput.snapshot = normalizeMarketSnapshot("solana", MINT, [{ ...pool, dexId: "a" }], TIME);
  // Exercise the role assessor's existing conflict handling at its normalized-input boundary.
  input.marketInput.snapshot.pools.push({ ...structuredClone(input.marketInput.snapshot.pools[0]), dexId: "b" });
  const result = composeSolanaHolderAssessment(input);
  const subject = result.exclusionAssessment.subjects.find(row => row.subjectAddress === OTHER);
  assert.equal(subject.decision, "unresolved");
  assert.ok(subject.ruleAssessments.some(rule => rule.evidenceSufficiency === "conflicting"));
  assert.equal(result.population.notExcluded.subjectCount, 2);
});

test("empty and supply-inconsistent populations keep existing unavailable semantics", () => {
  const empty = composeSolanaHolderAssessment(fixture({ balances: [], supply: "0" }));
  assert.equal(empty.population.notExcluded.subjectCount, 0);
  assert.equal(empty.concentration.notExcludedTopNCurrentMintSupplyShare.reason, "zero_supply");
  assert.equal(empty.concentration.notExcludedObservedPopulationTopNShare.reason, "zero_not_excluded_observed_balance_total");
  const inconsistent = composeSolanaHolderAssessment(fixture({ supply: "60" }));
  assert.equal(inconsistent.concentration.notExcludedTopNCurrentMintSupplyShare.reason, "supply_inconsistency");
  assert.equal(inconsistent.concentration.notExcludedObservedPopulationTopNShare.completeness, "partial");
});

test("composition rejects mismatched identities, supply, and forged snapshot IDs", () => {
  for (const mutate of [
    input => { input.mintResolution.mintAddress = OTHER; },
    input => { input.mintResolution.rawSupply = "101"; },
    input => { input.marketInput.snapshot.mintAddress = OTHER; },
    input => { input.holderSnapshot.snapshotId = "sha256:" + "0".repeat(64); },
    input => { input.mintResolution = { exists: false, isMint: false }; },
  ]) {
    const input = structuredClone(fixture());
    mutate(input);
    assert.throws(() => composeSolanaHolderAssessment(input));
  }
});

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("exact large balances, deterministic output, and input immutability survive composition", () => {
  const input = fixture({ balances: ["9007199254740993", "30"], supply: "10000000000000000" });
  const before = structuredClone(input);
  freeze(input);
  const result = composeSolanaHolderAssessment(input);
  assert.equal(result.population.notExcluded.observedBalanceRaw, "9007199254741023");
  assert.equal(result.concentration.notExcludedTopNCurrentMintSupplyShare.top1.numeratorRaw, "9007199254740993");
  assert.deepEqual(result, composeSolanaHolderAssessment(input));
  assert.deepEqual(input, before);
  result.population.subjects[0].balanceRaw = "1";
  assert.deepEqual(input, before);
});

test("import and composition work with network, provider, and database access blocked", () => {
  const script = `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(id, ...args) {
      if (/providers[\\/]|platform[\\/]database|^pg$/.test(id)) throw Error('forbidden import');
      return original.call(this, id, ...args);
    };
    global.fetch = () => { throw Error('network forbidden'); };
    require('node:net').Socket.prototype.connect = () => { throw Error('network forbidden'); };
    require('node:tls').connect = () => { throw Error('network forbidden'); };
    const { composeSolanaHolderAssessment } = require('./dist/application/solanaHolderAssessment.js');
    const input = ${JSON.stringify(fixture())};
    const result = composeSolanaHolderAssessment(input);
    if (result.population.notExcluded.subjectCount !== 2) process.exit(1);
  `;
  const child = spawnSync(process.execPath, ["-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});
