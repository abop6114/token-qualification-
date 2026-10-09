import type { SolanaMintResolution } from "./solanaMint";
import type {
  NormalizedMarketSnapshot,
  MarketProvenance,
  NormalizedPoolMarket,
} from "../types/market";
import type { SolanaHolderStructure } from "../types/holders";
import type { SolanaHolderSnapshotRecordV2 } from "../types/solanaHolderSnapshot";
import { validateSolanaHolderSnapshotRecordV2 } from "./solanaHolderSnapshotComparison";
import type {
  SolanaAddressRoleEvidence,
  SolanaAddressRoleMarketInput,
  SolanaAddressRoleMarketSource,
  SolanaAuthorityRoleSource,
  SolanaPoolAddressMatch,
  SolanaOwnerAuthorityRoleEvidence,
  SolanaBaseAuthorityAddressRoleFinding,
  SolanaDexPoolAddressRoleFinding,
  SolanaAddressRoleEvidenceV2,
  SolanaAuthorityRoleSourceV2,
} from "../types/solanaAddressRoleEvidence";
import { decodeSolanaPublicKey, encodeSolanaPublicKey, isSolanaPublicKeySyntax } from "../validation/solanaAddress";

export class SolanaAddressRoleEvidenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaAddressRoleEvidenceInputError";
  }
}

function fail(message: string): never {
  throw new SolanaAddressRoleEvidenceInputError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCanonicalPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !isSolanaPublicKeySyntax(value)) return false;
  const decoded = decodeSolanaPublicKey(value);
  return decoded !== null && encodeSolanaPublicKey(decoded) === value;
}

function assertMintResolution(value: unknown, mintAddress: string): asserts value is Extract<SolanaMintResolution, { isMint: true }> {
  if (!isObject(value) || value.exists !== true || value.isMint !== true
    || !isCanonicalPublicKey(value.mintAddress) || value.mintAddress !== mintAddress
    || (value.tokenProgram !== "spl-token" && value.tokenProgram !== "token-2022")
    || !Number.isInteger(value.decimals) || (value.decimals as number) < 0 || (value.decimals as number) > 255
    || typeof value.rawSupply !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.rawSupply)
    || !isObject(value.baseAuthorities)) {
    fail("A successful normalized Solana mint resolution is required.");
  }
  for (const key of ["mintAuthority", "freezeAuthority"] as const) {
    const authority: unknown = value.baseAuthorities[key];
    if (!isObject(authority)
      || authority.status === "set" && !isCanonicalPublicKey(authority.address)
      || authority.status === "unset" && authority.address !== null
      || authority.status !== "set" && authority.status !== "unset") {
      fail("Solana base authority evidence is malformed.");
    }
  }
}

function validateHolderStructure(value: unknown): asserts value is SolanaHolderStructure {
  if (!isObject(value) || value.chain !== "solana" || !isCanonicalPublicKey(value.mintAddress)
    || !validTime(value.fetchedAt) || !isObject(value.enumeration)
    || value.enumeration.completeness !== "complete"
    || value.enumeration.slotConsistency !== "not_guaranteed"
    || !Number.isSafeInteger(value.enumeration.pageCount) || (value.enumeration.pageCount as number) < 1
    || !Array.isArray(value.enumeration.contextSlots)
    || value.enumeration.contextSlots.length !== value.enumeration.pageCount
    || !value.enumeration.contextSlots.every((slot) => Number.isSafeInteger(slot) && slot >= 0)
    || !isObject(value.amountCoverage)
    || value.amountCoverage.state !== "complete" && value.amountCoverage.state !== "partial"
    || !Array.isArray(value.amountCoverage.unsupportedExtensionTypes)
    || (value.tokenProgram !== "spl-token" && value.tokenProgram !== "token-2022")
    || !Number.isInteger(value.decimals) || (value.decimals as number) < 0 || (value.decimals as number) > 255
    || typeof value.currentMintSupplyRaw !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.currentMintSupplyRaw)
    || !Number.isSafeInteger(value.rawOwnerCount) || !Array.isArray(value.rawOwnerAuthorities)
    || value.rawOwnerCount !== value.rawOwnerAuthorities.length) {
    fail("Solana holder structure is malformed or has unsupported enumeration semantics.");
  }
  const seen = new Set<string>();
  let observedPositiveBalance = 0n;
  for (const item of value.rawOwnerAuthorities) {
    if (!isObject(item) || !isCanonicalPublicKey(item.ownerAddress)
      || seen.has(item.ownerAddress) || typeof item.balanceRaw !== "string"
      || !/^[1-9][0-9]*$/.test(item.balanceRaw)) {
      fail("Solana positive owner-authority evidence is malformed.");
    }
    seen.add(item.ownerAddress);
    observedPositiveBalance += BigInt(item.balanceRaw);
  }
  if (typeof value.observedPositiveBalanceRaw !== "string"
    || value.observedPositiveBalanceRaw !== observedPositiveBalance.toString(10)
    || typeof value.supplyDifferenceRaw !== "string"
    || value.supplyDifferenceRaw !== (BigInt(value.currentMintSupplyRaw) - observedPositiveBalance).toString(10)) {
    fail("Solana holder balances do not reconcile with their preserved totals.");
  }
  if (value.amountCoverage.state === "complete"
    && (value.amountCoverage.reason !== null || value.amountCoverage.unsupportedExtensionTypes.length > 0)) {
    fail("Complete Solana amount coverage contradicts its supporting evidence.");
  }
  if (value.amountCoverage.state === "partial"
    && value.amountCoverage.reason !== "unsupported_balance_affecting_extension"
    && value.amountCoverage.reason !== "supply_inconsistency") {
    fail("Partial Solana amount coverage has no supported reason.");
  }
  if (value.amountCoverage.state === "partial"
    && value.amountCoverage.reason === "unsupported_balance_affecting_extension"
    && value.amountCoverage.unsupportedExtensionTypes.length === 0) {
    fail("Partial Solana amount coverage has no unsupported extension evidence.");
  }
  if ((value.amountCoverage.reason === "supply_inconsistency")
    !== (observedPositiveBalance > BigInt(value.currentMintSupplyRaw))) {
    fail("Solana holder supply-inconsistency evidence is contradictory.");
  }
}

function validateMarketProvenance(value: unknown): value is MarketProvenance {
  return isObject(value) && value.provider === "dexscreener"
    && validTime(value.fetchedAt)
    && (value.sourceUpdatedAt === null || validTime(value.sourceUpdatedAt));
}

function assertMarketSnapshot(snapshot: unknown, mintAddress: string): asserts snapshot is NormalizedMarketSnapshot {
  if (!isObject(snapshot) || snapshot.chain !== "solana" || snapshot.mintAddress !== mintAddress
    || !isCanonicalPublicKey(snapshot.mintAddress) || !validTime(snapshot.snapshotAt)
    || !validateMarketProvenance(snapshot.provenance) || snapshot.snapshotAt !== snapshot.provenance.fetchedAt
    || !Array.isArray(snapshot.pools)) {
    fail("Normalized Solana market evidence is malformed or has a mismatched chain/mint.");
  }
  for (const pool of snapshot.pools) {
    if (!isObject(pool) || typeof pool.dexId !== "string" || pool.dexId.length === 0
      || !validateMarketProvenance(pool.provenance)
      || pool.provenance.provider !== snapshot.provenance.provider
      || pool.provenance.fetchedAt !== snapshot.provenance.fetchedAt
      || pool.provenance.sourceUpdatedAt !== snapshot.provenance.sourceUpdatedAt) {
      fail("Normalized DEX Screener pool identity or provenance is malformed.");
    }
  }
}

function authoritySource(
  authority: { status: "set"; address: string } | { status: "unset"; address: null },
  holderAddresses: ReadonlySet<string>,
): SolanaAuthorityRoleSource {
  if (authority.status === "unset") {
    return {
      status: "unset",
      address: null,
      holderPopulationRelation: "not_applicable",
      basis: "solana_mint_resolution_base_field",
      sourceObservation: { evidence: "solana_mint_resolution", fetchedAt: null, contextSlot: null },
    };
  }
  return {
    status: "set",
    address: authority.address,
    holderPopulationRelation: holderAddresses.has(authority.address) ? "observed_positive" : "not_observed_positive",
    basis: "solana_mint_resolution_base_field",
    sourceObservation: { evidence: "solana_mint_resolution", fetchedAt: null, contextSlot: null },
  };
}

function authoritySourceV2(
  authority: { status: "set"; address: string } | { status: "unset"; address: null },
  holderAddresses: ReadonlySet<string>,
  snapshot: SolanaHolderSnapshotRecordV2["snapshot"],
): SolanaAuthorityRoleSourceV2 {
  const base = { basis: "solana_mint_resolution_base_field" as const, sourceObservation: { evidence: "solana_mint_resolution" as const, fetchedAt: null, contextSlot: null } };
  if (authority.status === "unset") return { status: "unset", address: null, holderPopulationRelation: "not_applicable", ...base };
  if (holderAddresses.has(authority.address)) return { status: "set", address: authority.address, holderPopulationRelation: "observed_positive", ...base };
  let reason: "enumeration_incomplete" | "amount_coverage_partial" | "supply_inconsistency" | null = null;
  if (snapshot.enumeration.completeness !== "complete") reason = "enumeration_incomplete";
  else if (snapshot.amountCoverage.reason === "supply_inconsistency" || BigInt(snapshot.supplyDifferenceRaw) < 0n) reason = "supply_inconsistency";
  else if (snapshot.amountCoverage.state !== "complete") reason = "amount_coverage_partial";
  return reason === null
    ? { status: "set", address: authority.address, holderPopulationRelation: "not_observed_positive", ...base }
    : { status: "set", address: authority.address, holderPopulationRelation: "unknown", reason, ...base };
}

function baseFinding(
  role: "base_mint_authority_address" | "base_freeze_authority_address",
  ownerAuthorityAddress: string,
  authority: { status: "set"; address: string } | { status: "unset"; address: null },
): SolanaBaseAuthorityAddressRoleFinding {
  if (authority.status === "set" && authority.address === ownerAuthorityAddress) {
    return {
      role,
      status: "observed_match",
      ownerAuthorityAddress,
      authorityAddress: authority.address,
      basis: "exact_address_equality",
      sourceEvidence: "solana_mint_resolution_base_field",
      sourceObservation: { fetchedAt: null, contextSlot: null },
    };
  }
  return {
    role,
    status: "no_match_in_examined_evidence",
    ownerAuthorityAddress,
    authorityStatus: authority.status,
    authorityAddress: authority.address,
    basis: "exact_address_equality",
    sourceEvidence: "solana_mint_resolution_base_field",
    sourceObservation: { fetchedAt: null, contextSlot: null },
  };
}

function makeMarketSource(
  market: SolanaAddressRoleMarketInput,
  mintAddress: string,
  invalidPoolCount: number,
  invalidPoolAddresses: string[],
  validPoolCount: number,
  conflictingPoolAddresses: string[],
): SolanaAddressRoleMarketSource {
  if (market.status === "unavailable") {
    return { status: "unavailable", provider: "dexscreener", chain: "solana", mintAddress, reason: market.reason };
  }
  const { snapshot } = market;
  return {
    status: "available",
    chain: "solana",
    mintAddress,
    snapshotAt: snapshot.snapshotAt,
    provenance: { ...snapshot.provenance },
    poolCount: snapshot.pools.length,
    validPoolAddressCount: validPoolCount,
    invalidPoolCount,
    invalidPoolAddresses: [...invalidPoolAddresses].sort(),
    conflictingPoolAddresses: [...conflictingPoolAddresses].sort(),
    suppliedPoolAddressValidation: invalidPoolCount === 0 ? "all_valid" : "invalid_present",
  };
}

function poolMatch(ownerAddress: string, matches: readonly SolanaPoolAddressMatch[], invalidPoolCount: number): SolanaDexPoolAddressRoleFinding {
  if (matches.length === 0) fail("Internal DEX pool match evidence is empty.");
  return {
    role: "dexscreener_reported_pool_address",
    status: "observed_match",
    ownerAuthorityAddress: ownerAddress,
    matches: [...matches].sort((left, right) => left.poolAddress < right.poolAddress ? -1
      : left.poolAddress > right.poolAddress ? 1 : left.dexId < right.dexId ? -1 : left.dexId > right.dexId ? 1 : 0),
    suppliedPoolAddressValidation: invalidPoolCount === 0 ? "all_valid" : "invalid_present",
  };
}

/** Correlates existing Solana evidence without provider calls, exclusions, or holder mutation. */
export function deriveSolanaAddressRoleEvidence(
  mintResolution: SolanaMintResolution,
  holderStructure: SolanaHolderStructure,
  marketInput: SolanaAddressRoleMarketInput,
): SolanaAddressRoleEvidence {
  validateHolderStructure(holderStructure);
  const mintAddress = holderStructure.mintAddress;
  assertMintResolution(mintResolution, mintAddress);
  if (!isObject(marketInput) || marketInput.status !== "available" && marketInput.status !== "unavailable") {
    fail("Solana market evidence input is malformed.");
  }

  const holderAddresses = new Set(holderStructure.rawOwnerAuthorities.map((owner) => owner.ownerAddress));
  const mintAuthoritySource = authoritySource(mintResolution.baseAuthorities.mintAuthority, holderAddresses);
  const freezeAuthoritySource = authoritySource(mintResolution.baseAuthorities.freezeAuthority, holderAddresses);
  let invalidPoolCount = 0;
  const invalidPoolAddresses: string[] = [];
  const matchesByAddress = new Map<string, Map<string, SolanaPoolAddressMatch>>();
  const ambiguousPoolDexIds = new Map<string, Set<string>>();
  let marketSource: SolanaAddressRoleMarketSource;

  if (marketInput.status === "unavailable") {
    if (marketInput.provider !== "dexscreener"
      || marketInput.reason !== "provider_error" && marketInput.reason !== "malformed_response") {
      fail("Solana market-unavailable reason is malformed.");
    }
    marketSource = { status: "unavailable", provider: "dexscreener", chain: "solana", mintAddress, reason: marketInput.reason };
  } else {
    assertMarketSnapshot(marketInput.snapshot, mintAddress);
    const snapshot = marketInput.snapshot;
    let validPoolCount = 0;
    for (let index = 0; index < snapshot.pools.length; index += 1) {
      const pool = snapshot.pools[index] as NormalizedPoolMarket;
      if (!isCanonicalPublicKey(pool.poolAddress)) {
        invalidPoolCount += 1;
        if (typeof pool.poolAddress === "string") invalidPoolAddresses.push(pool.poolAddress);
        continue;
      }
      validPoolCount += 1;
      const match: SolanaPoolAddressMatch = {
        poolAddress: pool.poolAddress,
        dexId: pool.dexId,
        chain: "solana",
        mintAddress,
        provenance: { ...snapshot.provenance },
      };
      const prior = matchesByAddress.get(pool.poolAddress);
      if (prior === undefined) {
        matchesByAddress.set(pool.poolAddress, new Map([[pool.dexId, match]]));
      } else {
        prior.set(pool.dexId, match);
        if (prior.size > 1) ambiguousPoolDexIds.set(pool.poolAddress, new Set(prior.keys()));
      }
    }
    marketSource = makeMarketSource(
      marketInput,
      mintAddress,
      invalidPoolCount,
      invalidPoolAddresses,
      validPoolCount,
      [...ambiguousPoolDexIds.keys()],
    );
  }

  const ownerAuthorities = holderStructure.rawOwnerAuthorities.map((owner): SolanaOwnerAuthorityRoleEvidence => {
    const dexFinding = (): SolanaDexPoolAddressRoleFinding => {
      if (marketInput.status === "unavailable") {
        return {
          role: "dexscreener_reported_pool_address",
          status: "unavailable",
          ownerAuthorityAddress: owner.ownerAddress,
          reason: "market_source_unavailable",
        };
      }
      const conflictingDexIds = ambiguousPoolDexIds.get(owner.ownerAddress);
      if (conflictingDexIds !== undefined) {
        return {
          role: "dexscreener_reported_pool_address",
          status: "ambiguous",
          ownerAuthorityAddress: owner.ownerAddress,
          poolAddress: owner.ownerAddress,
          conflictingDexIds: [...conflictingDexIds].sort(),
          provenance: { ...marketInput.snapshot.provenance },
        };
      }
      const matches = matchesByAddress.get(owner.ownerAddress);
      if (matches !== undefined) {
        return poolMatch(owner.ownerAddress, [...matches.values()], invalidPoolCount);
      }
      if (invalidPoolCount > 0) {
        return {
          role: "dexscreener_reported_pool_address",
          status: "unavailable",
          ownerAuthorityAddress: owner.ownerAddress,
          reason: "malformed_pool_address_present",
        };
      }
      if (ambiguousPoolDexIds.size > 0) {
        return {
          role: "dexscreener_reported_pool_address",
          status: "unavailable",
          ownerAuthorityAddress: owner.ownerAddress,
          reason: "conflicting_pool_address_evidence",
        };
      }
      return {
        role: "dexscreener_reported_pool_address",
        status: "no_match_in_examined_evidence",
        ownerAuthorityAddress: owner.ownerAddress,
        examinedPoolCount: matchesByAddress.size,
        provenance: { ...marketInput.snapshot.provenance },
      };
    };
    return {
      ownerAuthorityAddress: owner.ownerAddress,
      findings: [
        baseFinding("base_mint_authority_address", owner.ownerAddress, mintResolution.baseAuthorities.mintAuthority),
        baseFinding("base_freeze_authority_address", owner.ownerAddress, mintResolution.baseAuthorities.freezeAuthority),
        dexFinding(),
      ],
    };
  }).sort((left, right) => left.ownerAuthorityAddress < right.ownerAuthorityAddress ? -1
    : left.ownerAuthorityAddress > right.ownerAuthorityAddress ? 1 : 0);

  return {
    schemaVersion: "solana-address-role-evidence-v1",
    chain: "solana",
    mintAddress,
    holderSource: {
      evidence: "solana_holder_structure",
      fetchedAt: holderStructure.fetchedAt,
      enumeration: {
        ...holderStructure.enumeration,
        contextSlots: [...holderStructure.enumeration.contextSlots],
      },
      amountCoverage: {
        ...holderStructure.amountCoverage,
        unsupportedExtensionTypes: [...holderStructure.amountCoverage.unsupportedExtensionTypes],
      },
      observedPositiveOwnerAuthorityCount: holderStructure.rawOwnerCount,
    },
    baseMintAuthoritySource: mintAuthoritySource,
    baseFreezeAuthoritySource: freezeAuthoritySource,
    marketSource,
    ownerAuthorities,
  };
}

/** Correlates V2 snapshot evidence without treating an absent partial-row subject as absent population-wide. */
export function deriveSolanaAddressRoleEvidenceV2(
  mintResolution: SolanaMintResolution,
  holderSnapshot: SolanaHolderSnapshotRecordV2,
  marketInput: SolanaAddressRoleMarketInput,
): SolanaAddressRoleEvidenceV2 {
  try { validateSolanaHolderSnapshotRecordV2(holderSnapshot); } catch { fail("V2 holder snapshot record is invalid."); }
  const snapshot = holderSnapshot.snapshot;
  const mintAddress = snapshot.mintAddress;
  assertMintResolution(mintResolution, mintAddress);
  if (snapshot.chain !== "solana" || mintResolution.tokenProgram !== snapshot.tokenProgram
    || mintResolution.decimals !== snapshot.decimals || mintResolution.rawSupply !== snapshot.currentMintSupplyRaw) {
    fail("Mint resolution does not match the V2 holder snapshot identity or supply.");
  }
  if (!isObject(marketInput) || marketInput.status !== "available" && marketInput.status !== "unavailable") fail("Solana market evidence input is malformed.");

  const holderAddresses = new Set(snapshot.rawOwnerAuthorities.map((row) => row.ownerAddress));
  const mintAuthoritySource = authoritySourceV2(mintResolution.baseAuthorities.mintAuthority, holderAddresses, snapshot);
  const freezeAuthoritySource = authoritySourceV2(mintResolution.baseAuthorities.freezeAuthority, holderAddresses, snapshot);
  let invalidPoolCount = 0;
  const invalidPoolAddresses: string[] = [];
  const matchesByAddress = new Map<string, Map<string, SolanaPoolAddressMatch>>();
  const ambiguousPoolDexIds = new Map<string, Set<string>>();
  let marketSource: SolanaAddressRoleMarketSource;
  if (marketInput.status === "unavailable") {
    if (marketInput.provider !== "dexscreener" || (marketInput.reason !== "provider_error" && marketInput.reason !== "malformed_response")) fail("Solana market-unavailable reason is malformed.");
    marketSource = { status: "unavailable", provider: "dexscreener", chain: "solana", mintAddress, reason: marketInput.reason };
  } else {
    assertMarketSnapshot(marketInput.snapshot, mintAddress);
    let validPoolCount = 0;
    for (const pool of marketInput.snapshot.pools as readonly NormalizedPoolMarket[]) {
      if (!isCanonicalPublicKey(pool.poolAddress)) {
        invalidPoolCount += 1;
        if (typeof pool.poolAddress === "string") invalidPoolAddresses.push(pool.poolAddress);
        continue;
      }
      validPoolCount += 1;
      const match: SolanaPoolAddressMatch = { poolAddress: pool.poolAddress, dexId: pool.dexId, chain: "solana", mintAddress, provenance: { ...marketInput.snapshot.provenance } };
      const prior = matchesByAddress.get(pool.poolAddress);
      if (prior === undefined) matchesByAddress.set(pool.poolAddress, new Map([[pool.dexId, match]]));
      else {
        prior.set(pool.dexId, match);
        if (prior.size > 1) ambiguousPoolDexIds.set(pool.poolAddress, new Set(prior.keys()));
      }
    }
    marketSource = makeMarketSource(marketInput, mintAddress, invalidPoolCount, invalidPoolAddresses, validPoolCount, [...ambiguousPoolDexIds.keys()]);
  }

  const ownerAuthorities = snapshot.rawOwnerAuthorities.map((owner): SolanaOwnerAuthorityRoleEvidence => {
    let dexFinding: SolanaDexPoolAddressRoleFinding;
    if (marketInput.status === "unavailable") dexFinding = { role: "dexscreener_reported_pool_address", status: "unavailable", ownerAuthorityAddress: owner.ownerAddress, reason: "market_source_unavailable" };
    else {
      const conflictingDexIds = ambiguousPoolDexIds.get(owner.ownerAddress);
      const matches = matchesByAddress.get(owner.ownerAddress);
      if (conflictingDexIds !== undefined) dexFinding = { role: "dexscreener_reported_pool_address", status: "ambiguous", ownerAuthorityAddress: owner.ownerAddress, poolAddress: owner.ownerAddress, conflictingDexIds: [...conflictingDexIds].sort(), provenance: { ...marketInput.snapshot.provenance } };
      else if (matches !== undefined) dexFinding = poolMatch(owner.ownerAddress, [...matches.values()], invalidPoolCount);
      else if (invalidPoolCount > 0) dexFinding = { role: "dexscreener_reported_pool_address", status: "unavailable", ownerAuthorityAddress: owner.ownerAddress, reason: "malformed_pool_address_present" };
      else if (ambiguousPoolDexIds.size > 0) dexFinding = { role: "dexscreener_reported_pool_address", status: "unavailable", ownerAuthorityAddress: owner.ownerAddress, reason: "conflicting_pool_address_evidence" };
      else dexFinding = { role: "dexscreener_reported_pool_address", status: "no_match_in_examined_evidence", ownerAuthorityAddress: owner.ownerAddress, examinedPoolCount: matchesByAddress.size, provenance: { ...marketInput.snapshot.provenance } };
    }
    return { ownerAuthorityAddress: owner.ownerAddress, findings: [
      baseFinding("base_mint_authority_address", owner.ownerAddress, mintResolution.baseAuthorities.mintAuthority),
      baseFinding("base_freeze_authority_address", owner.ownerAddress, mintResolution.baseAuthorities.freezeAuthority),
      dexFinding,
    ] };
  }).sort((left, right) => left.ownerAuthorityAddress < right.ownerAuthorityAddress ? -1 : left.ownerAuthorityAddress > right.ownerAuthorityAddress ? 1 : 0);

  return {
    schemaVersion: "solana-address-role-evidence-v2", chain: "solana", mintAddress,
    holderSource: {
      evidence: "solana_holder_snapshot_record_v2", snapshotSchemaVersion: holderSnapshot.schemaVersion,
      snapshotId: holderSnapshot.snapshotId, fetchedAt: snapshot.fetchedAt, tokenProgram: snapshot.tokenProgram,
      decimals: snapshot.decimals,
      enumeration: structuredClone(snapshot.enumeration), acquisition: structuredClone(holderSnapshot.acquisition),
      amountCoverage: structuredClone(snapshot.amountCoverage), currentMintSupplyRaw: snapshot.currentMintSupplyRaw,
      supplyDifferenceRaw: snapshot.supplyDifferenceRaw, observedPositiveOwnerAuthorityCount: snapshot.rawOwnerCount,
    },
    baseMintAuthoritySource: mintAuthoritySource, baseFreezeAuthoritySource: freezeAuthoritySource,
    marketSource, ownerAuthorities,
  };
}
