const assert = require("node:assert/strict");
const { test } = require("node:test");
const { deriveSolanaAddressRoleEvidence } = require("../dist/normalization/solanaAddressRoleEvidence.js");
const { normalizeMarketSnapshot } = require("../dist/normalization/marketSnapshot.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const MINT = "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP";
const OTHER_MINT = "11111111111111111111111111111111";
const FETCHED_AT = "2026-10-07T12:00:00.000Z";
const MARKET_FETCHED_AT = "2026-10-07T12:01:00.000Z";

function key(seed) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 28);
  return encodeSolanaPublicKey(bytes);
}

const MINT_AUTHORITY = key(1);
const FREEZE_AUTHORITY = key(2);
const POOL_A = key(3);
const POOL_B = key(4);
const HOLDER_A = key(5);
const HOLDER_B = key(6);
const COUNTER_TOKEN = "11111111111111111111111111111111";

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

function holderStructure(ownerAddresses = [MINT_AUTHORITY, FREEZE_AUTHORITY, HOLDER_A]) {
  const rawOwnerAuthorities = ownerAddresses.map((ownerAddress, index) => ({
    ownerAddress,
    balanceRaw: String(index + 1),
    tokenAccountCount: 1,
  }));
  return {
    chain: "solana",
    mintAddress: MINT,
    tokenProgram: "spl-token",
    decimals: 6,
    currentMintSupplyRaw: "1000",
    observedPositiveBalanceRaw: rawOwnerAuthorities.reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n).toString(),
    supplyDifferenceRaw: (1000n - rawOwnerAuthorities.reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n)).toString(),
    fetchedAt: FETCHED_AT,
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [700, 701] },
    tokenAccountCount: rawOwnerAuthorities.length,
    nonzeroTokenAccountCount: rawOwnerAuthorities.length,
    tokenAccountStateSummary: {
      initialized: { tokenAccountCount: rawOwnerAuthorities.length, positiveBalanceTokenAccountCount: rawOwnerAuthorities.length, observedBalanceRaw: "6" },
      frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
    },
    rawOwnerCount: rawOwnerAuthorities.length,
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

function rawPool(poolAddress, liquidityUsd = 1, overrides = {}) {
  return {
    chainId: "solana",
    poolAddress,
    dexId: "test-dex",
    baseTokenAddress: MINT,
    quoteTokenAddress: COUNTER_TOKEN,
    priceUsd: "1",
    marketCapUsd: "1000",
    fdvUsd: "1000",
    liquidityUsd,
    volumeUsd: { h24: 10 },
    poolCreatedAt: null,
    ...overrides,
  };
}

function marketSnapshot(pools = [rawPool(POOL_A)]) {
  return normalizeMarketSnapshot("solana", MINT, pools, MARKET_FETCHED_AT);
}

function derive({
  resolution = mintResolution(),
  holder = holderStructure(),
  market = { status: "available", snapshot: marketSnapshot() },
} = {}) {
  return deriveSolanaAddressRoleEvidence(resolution, holder, market);
}

function finding(result, owner, role) {
  const entry = result.ownerAuthorities.find((item) => item.ownerAuthorityAddress === owner);
  assert.ok(entry, `missing holder authority ${owner}`);
  return entry.findings.find((item) => item.role === role);
}

test("matches a positive owner authority to the set base mint authority", () => {
  assert.deepEqual(finding(derive(), MINT_AUTHORITY, "base_mint_authority_address"), {
    role: "base_mint_authority_address",
    status: "observed_match",
    ownerAuthorityAddress: MINT_AUTHORITY,
    authorityAddress: MINT_AUTHORITY,
    basis: "exact_address_equality",
    sourceEvidence: "solana_mint_resolution_base_field",
    sourceObservation: { fetchedAt: null, contextSlot: null },
  });
});

test("matches a positive owner authority to the set base freeze authority", () => {
  assert.equal(finding(derive(), FREEZE_AUTHORITY, "base_freeze_authority_address").status, "observed_match");
});

test("one authority can match both base mint and freeze authority roles", () => {
  const result = derive({ resolution: mintResolution({ freezeAuthority: MINT_AUTHORITY }) });
  assert.equal(finding(result, MINT_AUTHORITY, "base_mint_authority_address").status, "observed_match");
  assert.equal(finding(result, MINT_AUTHORITY, "base_freeze_authority_address").status, "observed_match");
});

test("records a set authority that is absent from the positive holder population without adding it", () => {
  const result = derive({ holder: holderStructure([HOLDER_A]) });
  assert.deepEqual(result.baseMintAuthoritySource, {
    status: "set",
    address: MINT_AUTHORITY,
    holderPopulationRelation: "not_observed_positive",
    basis: "solana_mint_resolution_base_field",
    sourceObservation: { evidence: "solana_mint_resolution", fetchedAt: null, contextSlot: null },
  });
  assert.equal(result.ownerAuthorities.some((item) => item.ownerAuthorityAddress === MINT_AUTHORITY), false);
});

test("unset base authorities remain explicit and produce examined no-match states", () => {
  const result = derive({ resolution: mintResolution({ mintAuthority: null, freezeAuthority: null }) });
  assert.equal(result.baseMintAuthoritySource.status, "unset");
  assert.equal(result.baseFreezeAuthoritySource.status, "unset");
  assert.equal(finding(result, HOLDER_A, "base_mint_authority_address").authorityStatus, "unset");
  assert.equal(finding(result, HOLDER_A, "base_freeze_authority_address").authorityStatus, "unset");
});

test("matches an exact DEX Screener pool address to an owner authority", () => {
  const result = derive({ holder: holderStructure([POOL_A]) });
  const poolFinding = finding(result, POOL_A, "dexscreener_reported_pool_address");
  assert.equal(poolFinding.status, "observed_match");
  assert.equal(poolFinding.matches[0].poolAddress, POOL_A);
  assert.equal(poolFinding.matches[0].dexId, "test-dex");
  assert.equal(poolFinding.matches[0].chain, "solana");
  assert.equal(poolFinding.matches[0].mintAddress, MINT);
  assert.deepEqual(poolFinding.matches[0].provenance, {
    provider: "dexscreener", fetchedAt: MARKET_FETCHED_AT, sourceUpdatedAt: null,
  });
});

test("matches a non-primary pool because all normalized pools are examined", () => {
  const result = derive({
    holder: holderStructure([POOL_B]),
    market: { status: "available", snapshot: marketSnapshot([rawPool(POOL_A, 500), rawPool(POOL_B, 1)]) },
  });
  assert.equal(result.marketSource.status, "available");
  assert.equal(result.ownerAuthorities[0].findings[2].status, "observed_match");
  assert.equal(result.ownerAuthorities[0].findings[2].matches[0].poolAddress, POOL_B);
});

test("retains multiple matching pool observations in deterministic address order", () => {
  const pools = [
    rawPool(POOL_B, 5, { dexId: "dex-z" }),
    rawPool(POOL_A, 10, { dexId: "dex-a" }),
  ];
  const result = derive({ holder: holderStructure([POOL_A, POOL_B]), market: { status: "available", snapshot: marketSnapshot(pools) } });
  const reversed = derive({ holder: holderStructure([POOL_B, POOL_A]), market: { status: "available", snapshot: marketSnapshot([...pools].reverse()) } });
  assert.deepEqual(finding(result, POOL_A, "dexscreener_reported_pool_address").matches.map((row) => row.poolAddress), [POOL_A]);
  assert.equal(finding(result, POOL_B, "dexscreener_reported_pool_address").matches[0].poolAddress, POOL_B);
  assert.deepEqual(reversed.ownerAuthorities, result.ownerAuthorities);
});

test("a complete market examination with no address equality reports only an examined no-match", () => {
  const result = derive({ holder: holderStructure([HOLDER_A]) });
  assert.deepEqual(finding(result, HOLDER_A, "dexscreener_reported_pool_address"), {
    role: "dexscreener_reported_pool_address",
    status: "no_match_in_examined_evidence",
    ownerAuthorityAddress: HOLDER_A,
    examinedPoolCount: 1,
    provenance: { provider: "dexscreener", fetchedAt: MARKET_FETCHED_AT, sourceUpdatedAt: null },
  });
});

test("successful empty market evidence is distinct from unavailable market evidence", () => {
  const empty = derive({ holder: holderStructure([HOLDER_A]), market: { status: "available", snapshot: marketSnapshot([]) } });
  const unavailable = derive({ holder: holderStructure([HOLDER_A]), market: { status: "unavailable", provider: "dexscreener", reason: "provider_error" } });
  assert.equal(finding(empty, HOLDER_A, "dexscreener_reported_pool_address").status, "no_match_in_examined_evidence");
  assert.equal(finding(empty, HOLDER_A, "dexscreener_reported_pool_address").examinedPoolCount, 0);
  assert.equal(finding(unavailable, HOLDER_A, "dexscreener_reported_pool_address").status, "unavailable");
  assert.equal(finding(unavailable, HOLDER_A, "dexscreener_reported_pool_address").reason, "market_source_unavailable");
});

test("an invalid pool public key prevents a clean no-match and never creates a match", () => {
  const malformedSnapshot = {
    ...marketSnapshot([]),
    pools: [{ ...normalizeMarketSnapshot("solana", MINT, [rawPool(POOL_A)], MARKET_FETCHED_AT).pools[0], poolAddress: "not-a-public-key" }],
  };
  const result = derive({
    holder: holderStructure([HOLDER_A]),
    market: { status: "available", snapshot: malformedSnapshot },
  });
  assert.equal(result.marketSource.status, "available");
  assert.equal(result.marketSource.suppliedPoolAddressValidation, "invalid_present");
  assert.equal(result.marketSource.invalidPoolCount, 1);
  assert.deepEqual(result.marketSource.invalidPoolAddresses, ["not-a-public-key"]);
  assert.equal(finding(result, HOLDER_A, "dexscreener_reported_pool_address").status, "unavailable");
  assert.equal(finding(result, HOLDER_A, "dexscreener_reported_pool_address").reason, "malformed_pool_address_present");
});

test("retains a valid pool match while marking another supplied invalid address", () => {
  const validPool = normalizeMarketSnapshot("solana", MINT, [rawPool(POOL_A)], MARKET_FETCHED_AT).pools[0];
  const malformedSnapshot = {
    ...marketSnapshot([]),
    pools: [validPool, { ...validPool, poolAddress: "not-a-public-key" }],
  };
  const result = derive({
    holder: holderStructure([POOL_A]),
    market: { status: "available", snapshot: malformedSnapshot },
  });
  const poolFinding = finding(result, POOL_A, "dexscreener_reported_pool_address");
  assert.equal(poolFinding.status, "observed_match");
  assert.equal(poolFinding.suppliedPoolAddressValidation, "invalid_present");
  assert.equal(result.marketSource.suppliedPoolAddressValidation, "invalid_present");
});

test("base, quote, and counter-token identities do not create pool-address matches", () => {
  const snapshot = marketSnapshot([rawPool(POOL_A)]);
  const result = derive({ holder: holderStructure([MINT, COUNTER_TOKEN]), market: { status: "available", snapshot } });
  for (const owner of [MINT, COUNTER_TOKEN]) {
    assert.notEqual(finding(result, owner, "dexscreener_reported_pool_address").status, "observed_match");
  }
});

test("rejects chain or mint mismatches rather than reporting no-match", () => {
  const holder = holderStructure([HOLDER_A]);
  assert.throws(() => derive({ market: { status: "available", snapshot: { ...marketSnapshot(), chain: "ethereum" } } }), /chain\/mint/);
  assert.throws(() => derive({ market: { status: "available", snapshot: { ...marketSnapshot(), mintAddress: key(99) } } }), /chain\/mint/);
  assert.throws(() => derive({ holder: { ...holder, chain: "base" } }), /holder structure/);
});

test("rejects mint-resolution authority evidence bound to a different mint", () => {
  const resolutionForOtherMint = { ...mintResolution(), mintAddress: OTHER_MINT };
  assert.throws(
    () => derive({ resolution: resolutionForOtherMint, holder: holderStructure([MINT_AUTHORITY]) }),
    /mint resolution/,
  );
});

test("identical normalized pools collapse to one finding and pool ordering is independent of input order", () => {
  const duplicate = rawPool(POOL_A);
  const one = marketSnapshot([duplicate]);
  const repeated = marketSnapshot([duplicate, { ...duplicate }]);
  const first = derive({ holder: holderStructure([POOL_A]), market: { status: "available", snapshot: one } });
  const second = derive({ holder: holderStructure([POOL_A]), market: { status: "available", snapshot: repeated } });
  assert.equal(finding(second, POOL_A, "dexscreener_reported_pool_address").matches.length, 1);
  assert.deepEqual(second.ownerAuthorities, first.ownerAuthorities);
  assert.throws(() => marketSnapshot([rawPool(POOL_A), rawPool(POOL_A, 2)]), /Conflicting duplicate market observations/);
});

test("conflicting duplicate pool identities are explicit ambiguous evidence", () => {
  const basePool = marketSnapshot([rawPool(POOL_A)]).pools[0];
  const snapshot = {
    ...marketSnapshot([]),
    pools: [basePool, { ...basePool, dexId: "other-dex" }],
  };
  const result = derive({ holder: holderStructure([POOL_A]), market: { status: "available", snapshot } });
  const role = finding(result, POOL_A, "dexscreener_reported_pool_address");
  assert.equal(role.status, "ambiguous");
  assert.deepEqual(role.conflictingDexIds, ["other-dex", "test-dex"]);
  assert.equal(result.marketSource.suppliedPoolAddressValidation, "all_valid");
});

test("partial amount coverage is preserved and is not upgraded by role evidence", () => {
  const holder = holderStructure([POOL_A]);
  holder.amountCoverage = {
    state: "partial",
    unsupportedExtensionTypes: [2],
    reason: "unsupported_balance_affecting_extension",
  };
  const result = derive({ holder, market: { status: "available", snapshot: marketSnapshot([rawPool(POOL_A)]) } });
  assert.deepEqual(result.holderSource.amountCoverage, holder.amountCoverage);
  assert.deepEqual(result.holderSource.enumeration, holder.enumeration);
});

test("keeps holder, mint, and market observation points independent", () => {
  const result = derive({ holder: holderStructure([POOL_A]), market: { status: "available", snapshot: marketSnapshot([rawPool(POOL_A)]) } });
  assert.equal(result.holderSource.fetchedAt, FETCHED_AT);
  assert.deepEqual(result.holderSource.enumeration.contextSlots, [700, 701]);
  assert.equal(result.marketSource.provenance.fetchedAt, MARKET_FETCHED_AT);
  assert.deepEqual(result.baseMintAuthoritySource.sourceObservation, {
    evidence: "solana_mint_resolution", fetchedAt: null, contextSlot: null,
  });
  assert.notEqual(result.holderSource.fetchedAt, result.marketSource.provenance.fetchedAt);
});

test("does not introduce zero-balance or non-holder authorities", () => {
  const result = derive({ holder: holderStructure([HOLDER_A]) });
  assert.deepEqual(result.ownerAuthorities.map((row) => row.ownerAuthorityAddress), [HOLDER_A]);
  const malformedHolder = holderStructure([HOLDER_A]);
  malformedHolder.rawOwnerAuthorities.push({ ownerAddress: HOLDER_B, balanceRaw: "0", tokenAccountCount: 1 });
  malformedHolder.rawOwnerCount += 1;
  assert.throws(() => derive({ holder: malformedHolder }), /positive owner-authority/);
});

test("does not mutate holder structure or raw concentration", () => {
  const holder = holderStructure([MINT_AUTHORITY, POOL_A]);
  const before = structuredClone(holder);
  derive({ holder, market: { status: "available", snapshot: marketSnapshot([rawPool(POOL_A)]) } });
  assert.deepEqual(holder, before);
});

test("rejects malformed mint authority, non-mint resolution, and holder evidence", () => {
  assert.throws(() => derive({ resolution: { ...mintResolution(), isMint: false } }), /mint resolution/);
  assert.throws(() => derive({ resolution: mintResolution({ mintAuthority: "invalid" }) }), /base authority/);
  assert.throws(() => derive({ holder: { ...holderStructure(), amountCoverage: { state: "partial", unsupportedExtensionTypes: [], reason: null } } }), /Partial Solana amount coverage/);
});
