import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";
import type { SolanaTokenEvidenceReport } from "../types/solanaTokenEvidenceReport";
import type { MarketMetric, NormalizedPoolMarket } from "../types/market";
import type { SolanaHistoricalMetricValue } from "../types/solanaHistoricalMetrics";
import {
  SOLANA_QUALIFICATION_METRIC_EVIDENCE_SCHEMA_VERSION,
  type SolanaQualificationMetricCompleteness,
  type SolanaQualificationMetricEvidence,
  type SolanaQualificationMetricEvidenceEntry,
  type SolanaQualificationMetricEvidenceInputErrorReason,
  type SolanaQualificationMetricId,
  type SolanaQualificationMetricJsonValue,
  type SolanaQualificationMetricSource,
  type SolanaQualificationMetricStatus,
} from "../types/solanaQualificationMetricEvidence";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: SolanaQualificationMetricEvidenceInputErrorReason = "malformed_report"): never {
  throw new SolanaQualificationMetricEvidenceInputError(reason);
}

export class SolanaQualificationMetricEvidenceInputError extends Error {
  constructor(readonly reason: SolanaQualificationMetricEvidenceInputErrorReason) {
    super(reason === "identity_mismatch"
      ? "Solana qualification metric report identities do not match."
      : "Solana qualification metric report is malformed.");
    this.name = "SolanaQualificationMetricEvidenceInputError";
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCanonicalUnsigned(value: unknown): value is string {
  return typeof value === "string" && fullMatch(value, /^(?:0|[1-9][0-9]*)$/);
}

function fullMatch(value: string, pattern: RegExp): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0] === value;
}

function assertMetric(value: unknown): asserts value is UnknownRecord {
  if (!isRecord(value)) fail();
  if (value.status === "available") {
    if (typeof value.value !== "string" || !["provider_reported", "calculated"].includes(String(value.basis))) fail();
    return;
  }
  if (value.status !== "unavailable" || value.value !== null
    || !["not_reported", "no_market", "no_creation_evidence", "orientation_unsupported"].includes(String(value.reason))) fail();
}

function assertReport(input: unknown): asserts input is SolanaTokenEvidenceReport {
  if (!isRecord(input) || input.schemaVersion !== "solana-token-evidence-report-v1" || input.chain !== "solana"
    || typeof input.assetAddress !== "string" || !isSolanaPublicKeySyntax(input.assetAddress)
    || !isIsoDate(input.generatedAt)) fail();

  const statuses: Record<string, readonly string[]> = {
    mint: ["present", "unavailable", "not_attempted"],
    market: ["present", "unavailable", "not_attempted"],
    holders: ["present", "unavailable", "not_attempted"],
    historicalTransactions: ["present", "unavailable", "not_attempted", "not_requested"],
  };
  for (const [name, accepted] of Object.entries(statuses)) {
    const section = input[name];
    if (!isRecord(section) || !accepted.includes(String(section.status))) fail();
    if (section.status !== "present" && section.status !== "not_requested" && typeof section.reason !== "string") fail();
  }

  const mint = input.mint as UnknownRecord;
  if (mint.status === "present") {
    const evidence = mint.evidence;
    if (!isRecord(evidence) || !isRecord(evidence.resolution)) fail();
    const resolution = evidence.resolution;
    if (resolution.exists === true && resolution.isMint === true) {
      if (resolution.mintAddress !== input.assetAddress) fail("identity_mismatch");
      if (!["spl-token", "token-2022"].includes(String(resolution.tokenProgram))
        || !Number.isInteger(resolution.decimals) || (resolution.decimals as number) < 0
        || (resolution.decimals as number) > 255 || !isCanonicalUnsigned(resolution.rawSupply)
        || !isRecord(resolution.baseAuthorities)) fail();
      for (const role of ["mintAuthority", "freezeAuthority"]) {
        const authority = resolution.baseAuthorities[role];
        if (!isRecord(authority) || (authority.status === "unset" && authority.address !== null)
          || (authority.status === "set" && (typeof authority.address !== "string" || !isSolanaPublicKeySyntax(authority.address)))
          || !["set", "unset"].includes(String(authority.status))) fail();
      }
      const inventory = evidence.token2022MintExtensionInventory;
      if (!isRecord(inventory) || inventory.schemaVersion !== "solana-token-2022-mint-extension-inventory-v1"
        || inventory.chain !== "solana" || inventory.mintAddress !== input.assetAddress
        || inventory.tokenProgram !== resolution.tokenProgram) fail("identity_mismatch");
      if ((resolution.tokenProgram === "spl-token" && inventory.status !== "not_applicable")
        || (resolution.tokenProgram === "token-2022" && !["available", "malformed"].includes(String(inventory.status)))) fail();
      if (inventory.status === "available" && !Array.isArray(inventory.extensions)) fail();
      if (inventory.status === "malformed" && inventory.reason !== "duplicate_extension_type") fail();
    } else if (!((resolution.exists === false && resolution.isMint === false)
      || (resolution.exists === true && resolution.isMint === false))) fail();
  }

  const market = input.market as UnknownRecord;
  if (market.status === "present") {
    const snapshot = market.evidence;
    if (!isRecord(snapshot) || snapshot.chain !== "solana" || snapshot.mintAddress !== input.assetAddress) fail("identity_mismatch");
    if (!isIsoDate(snapshot.snapshotAt) || !Array.isArray(snapshot.pools) || !isRecord(snapshot.provenance)
      || snapshot.provenance.provider !== "dexscreener" || !isIsoDate(snapshot.provenance.fetchedAt)) fail();
    if (snapshot.primaryPoolAddress !== null && (typeof snapshot.primaryPoolAddress !== "string"
      || !snapshot.pools.some((pool) => isRecord(pool) && pool.poolAddress === snapshot.primaryPoolAddress))) fail();
    for (const pool of snapshot.pools) {
      if (!isRecord(pool) || typeof pool.poolAddress !== "string" || typeof pool.dexId !== "string" || !isRecord(pool.provenance)
        || !isIsoDate(pool.provenance.fetchedAt)) fail();
      for (const metric of [pool.priceUsd, pool.marketCapUsd, pool.fdvUsd, pool.liquidityUsd]) assertMetric(metric);
      if (!isRecord(pool.volumeUsd)) fail();
      for (const window of ["m5", "h1", "h6", "h24"]) assertMetric(pool.volumeUsd[window]);
    }
  }

  const holders = input.holders as UnknownRecord;
  if (holders.status === "present") {
    const evidence = holders.evidence;
    if (!isRecord(evidence) || !isRecord(evidence.holderStructure) || !isRecord(evidence.ownerAuthorityBalanceDistribution)) fail();
    const structure = evidence.holderStructure;
    const distribution = evidence.ownerAuthorityBalanceDistribution;
    if (structure.chain !== "solana" || structure.mintAddress !== input.assetAddress
      || distribution.chain !== "solana" || distribution.assetAddress !== input.assetAddress) fail("identity_mismatch");
    if (!isCanonicalUnsigned(structure.currentMintSupplyRaw) || !isCanonicalUnsigned(structure.observedPositiveBalanceRaw)
      || typeof structure.supplyDifferenceRaw !== "string"
      || !fullMatch(structure.supplyDifferenceRaw, /^(?:0|-?[1-9][0-9]*)$/)
      || !isIsoDate(structure.fetchedAt) || !isRecord(structure.enumeration) || !isRecord(structure.amountCoverage)
      || !isRecord(structure.concentration) || !isRecord(distribution.coverage)) fail();
    if (!["complete", "partial"].includes(String(structure.enumeration.completeness))
      || !["complete", "partial"].includes(String(structure.amountCoverage.state))
      || !["complete", "partial"].includes(String(distribution.coverage.state))) fail();
  }

  const history = input.historicalTransactions as UnknownRecord;
  if (history.status === "present") {
    const evidence = history.evidence;
    if (!isRecord(evidence) || !isRecord(evidence.queryPlan) || !isRecord(evidence.execution)
      || !isRecord(evidence.execution.evidence) || !isRecord(evidence.descriptiveMetrics)
      || !isRecord(evidence.transactionIntegration) || !isRecord(evidence.transactionIntegration.coverage)) fail();
    if (evidence.queryPlan.mintAddress !== input.assetAddress || evidence.execution.evidence.mintAddress !== input.assetAddress
      || !isRecord(evidence.descriptiveMetrics.source) || evidence.descriptiveMetrics.source.mintAddress !== input.assetAddress) fail("identity_mismatch");
    if (!Array.isArray(evidence.descriptiveMetrics.authorities) || !isRecord(evidence.queryPlan.requestedWindow)) fail();
  }
}

function source(
  section: SolanaQualificationMetricSource["section"],
  fieldPath: string,
  options: Partial<Omit<SolanaQualificationMetricSource, "section" | "fieldPath">> = {},
): SolanaQualificationMetricSource {
  return {
    section, fieldPath, provider: options.provider ?? null, method: options.method ?? null,
    observedAt: options.observedAt ?? null, sourceUpdatedAt: options.sourceUpdatedAt ?? null,
    contextSlots: options.contextSlots == null ? null : [...options.contextSlots],
  };
}

function copyJson(value: unknown): SolanaQualificationMetricJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(copyJson);
  if (isRecord(value)) {
    const copy: Record<string, SolanaQualificationMetricJsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) fail();
      copy[key] = copyJson(child);
    }
    return copy;
  }
  return fail();
}

function entry(
  id: SolanaQualificationMetricId,
  label: string,
  status: SolanaQualificationMetricStatus,
  value: unknown,
  unit: string | null,
  sourceRef: SolanaQualificationMetricSource,
  options: {
    completeness?: SolanaQualificationMetricCompleteness;
    reason?: string | null;
    limitation?: string | null;
    numeratorRaw?: string | null;
    denominatorRaw?: string | null;
    measurementBasis?: string | null;
    evidenceKind?: "provider_observation" | "deterministic_derivation";
    scope?: SolanaQualificationMetricEvidenceEntry["scope"];
  } = {},
): SolanaQualificationMetricEvidenceEntry {
  return {
    id, label, status, value: copyJson(value), unit,
    numeratorRaw: options.numeratorRaw ?? null, denominatorRaw: options.denominatorRaw ?? null,
    measurementBasis: options.measurementBasis ?? null, evidenceKind: options.evidenceKind ?? "deterministic_derivation",
    completeness: options.completeness ?? null, reason: options.reason ?? null,
    limitation: options.limitation ?? null, source: sourceRef, scope: options.scope ?? null,
  };
}

function failedSection(section: { status: string; reason?: string }): { status: SolanaQualificationMetricStatus; reason: string } | null {
  if (section.status === "present") return null;
  if (section.status === "not_attempted") return { status: "not_attempted", reason: section.reason ?? "not_attempted" };
  if (section.status === "not_requested") return { status: "not_requested", reason: "not_requested" };
  return { status: "unavailable", reason: section.reason ?? "unavailable" };
}

function marketMetric(
  id: SolanaQualificationMetricId,
  label: string,
  metric: MarketMetric<string> | null,
  report: SolanaTokenEvidenceReport,
  pool: NormalizedPoolMarket | null,
  fieldPath: string,
): SolanaQualificationMetricEvidenceEntry {
  const section = report.market;
  if (section.status !== "present") {
    const failure = failedSection(section)!;
    return entry(id, label, failure.status, null, "USD", source("market", "report.market"), { reason: failure.reason });
  }
  const snapshot = section.evidence;
  const sourceRef = pool
    ? source("market", fieldPath, { provider: pool.provenance.provider, method: "token-pairs", observedAt: pool.provenance.fetchedAt, sourceUpdatedAt: pool.provenance.sourceUpdatedAt })
    : source("market", "report.market.evidence.primaryPoolAddress", { provider: snapshot.provenance.provider, method: "token-pairs", observedAt: snapshot.snapshotAt, sourceUpdatedAt: snapshot.provenance.sourceUpdatedAt });
  if (!pool) return entry(id, label, "unavailable", null, "USD", sourceRef, { reason: "no_market" });
  if (!metric) fail();
  const scope = { kind: "selected_pool" as const, address: pool.poolAddress };
  if (metric.status === "unavailable") return entry(id, label, "unavailable", null, "USD", sourceRef, {
    reason: metric.reason,
    limitation: metric.reason === "orientation_unsupported" ? "Token-oriented provider metrics are not attributed when the requested mint is quote-side." : null,
    scope,
  });
  return entry(id, label, "available", metric.value, "USD", sourceRef, {
    evidenceKind: metric.basis === "provider_reported" ? "provider_observation" : "deterministic_derivation",
    measurementBasis: metric.basis,
    limitation: "One selected pool observation only; no cross-pool aggregation or stability inference.", scope,
  });
}

function holderEntries(report: SolanaTokenEvidenceReport): SolanaQualificationMetricEvidenceEntry[] {
  const section = report.holders;
  const definitions = [
    ["holders.token_account_count", "Observed token-account count", "token accounts"],
    ["holders.nonzero_token_account_count", "Observed positive-balance token-account count", "token accounts"],
    ["holders.positive_owner_authority_count", "Observed positive owner-authority count", "owner authorities"],
    ["holders.observed_positive_balance_raw", "Observed positive balance total", "raw token units"],
    ["holders.current_mint_supply_raw", "Current mint supply", "raw token units"],
    ["holders.supply_difference_raw", "Current supply minus observed positive balance total", "raw token units"],
  ] as const;
  if (section.status !== "present") {
    const failure = failedSection(section)!;
    return definitions.map(([id, label, unit]) => entry(id, label, failure.status, null, unit, source("holders", "report.holders"), { reason: failure.reason }));
  }

  const { holderStructure: structure, ownerAuthorityBalanceDistribution: distribution } = section.evidence;
  const enumerationComplete = structure.enumeration.completeness === "complete";
  const amountComplete = structure.amountCoverage.state === "complete" && structure.amountCoverage.reason === null
    && structure.amountCoverage.unsupportedExtensionTypes.length === 0;
  const distributionComplete = enumerationComplete && amountComplete
    && distribution.coverage.state === "complete"
    && distribution.coverage.enumerationCompleteness === "complete"
    && distribution.coverage.amountCoverageState === "complete"
    && distribution.coverage.amountCoverageReason === null
    && distribution.coverage.unsupportedExtensionTypes.length === 0;
  const observedCompleteness: SolanaQualificationMetricCompleteness = enumerationComplete ? "complete" : "partial";
  const amountCompleteness: SolanaQualificationMetricCompleteness = enumerationComplete && amountComplete ? "complete" : "partial";
  const distributionCompleteness: SolanaQualificationMetricCompleteness = distributionComplete ? "complete" : "partial";
  const holderSource = source("holders", "report.holders.evidence.holderStructure", {
    provider: "helius", method: "getProgramAccountsV2", observedAt: structure.fetchedAt, contextSlots: structure.enumeration.contextSlots,
  });
  const distributionSource = source("holders", "report.holders.evidence.ownerAuthorityBalanceDistribution", {
    provider: "helius", method: "getProgramAccountsV2", observedAt: distribution.coverage.sourceSnapshotAt, contextSlots: distribution.coverage.contextSlots,
  });
  const countLimit = enumerationComplete
    ? "Observed token accounts; page context slots do not imply one atomic ledger snapshot."
    : "Accepted observed pages only; enumeration is partial.";
  const amountLimit = amountCompleteness === "complete"
    ? "Owner authorities are not verified wallets, people, or beneficial owners; holder and mint reads are not proven atomic."
    : "Observed values are partial under the source enumeration or amount-coverage state.";
  const entries: SolanaQualificationMetricEvidenceEntry[] = [
    entry("holders.token_account_count", "Observed token-account count", "available", structure.tokenAccountCount, "token accounts", holderSource, { completeness: observedCompleteness, measurementBasis: "valid token-account rows in accepted pages", limitation: countLimit }),
    entry("holders.nonzero_token_account_count", "Observed positive-balance token-account count", "available", structure.nonzeroTokenAccountCount, "token accounts", holderSource, { completeness: amountCompleteness, measurementBasis: "token accounts with decoded positive raw amount", limitation: amountLimit }),
    entry("holders.positive_owner_authority_count", "Observed positive owner-authority count", "available", structure.rawOwnerCount, "owner authorities", holderSource, { completeness: amountCompleteness, limitation: "Distinct positive-balance token-account owner authorities, not independent wallets or economic owners." }),
    entry("holders.observed_positive_balance_raw", "Observed positive balance total", "available", structure.observedPositiveBalanceRaw, "raw token units", distributionSource, { completeness: distributionCompleteness, measurementBasis: "Existing exact owner-authority balance total", limitation: amountLimit }),
    entry("holders.current_mint_supply_raw", "Current mint supply", "available", structure.currentMintSupplyRaw, "raw token units", source("holders", "report.holders.evidence.holderStructure.currentMintSupplyRaw", { provider: "helius" }), { measurementBasis: "Mint account raw supply; no atomicity with holder pages is established." }),
    entry("holders.supply_difference_raw", "Current supply minus observed positive balance total", "available", structure.supplyDifferenceRaw, "raw token units", distributionSource, { completeness: distributionCompleteness, numeratorRaw: structure.supplyDifferenceRaw, measurementBasis: "Existing currentMintSupplyRaw minus observedPositiveBalanceRaw", limitation: "Descriptive difference only; no cause is inferred." }),
  ];

  for (const topN of [1, 5, 10, 20] as const) {
    const key = `top${topN}` as const;
    const metric = structure.concentration[key];
    const id = `holders.concentration_${key}` as SolanaQualificationMetricId;
    if (metric.status === "available") {
      entries.push(entry(id, `Raw ${key} current-supply concentration`, "available", metric.percentage, "percent", holderSource, {
        completeness: enumerationComplete && amountComplete && structure.supplyDifferenceRaw[0] !== "-" ? "complete" : "partial",
        numeratorRaw: metric.numeratorRaw, denominatorRaw: metric.denominatorRaw,
        measurementBasis: "Existing holder normalizer; numerator/current mint supply; six-decimal half-up.",
        limitation: "Uses positive owner-authority balances; not economic-control concentration.",
      }));
    } else {
      entries.push(entry(id, `Raw ${key} current-supply concentration`, "unavailable", null, "percent", holderSource, {
        reason: metric.reason, denominatorRaw: metric.denominatorRaw,
        measurementBasis: "Existing holder normalizer; current mint supply denominator; no percentage recalculated.",
      }));
    }
  }

  const facts: readonly [SolanaQualificationMetricId, string, unknown, string | null][] = [
    ["holders.distribution.minimum_balance_raw", "Minimum positive owner-authority balance", distribution.minimumBalanceRaw, "raw token units"],
    ["holders.distribution.maximum_balance_raw", "Maximum positive owner-authority balance", distribution.maximumBalanceRaw, "raw token units"],
    ["holders.distribution.median_balance_raw", "Median positive owner-authority balance", distribution.medianBalanceRaw, "raw token units"],
    ["holders.distribution.quantile_p25_raw", "Nearest-rank p25 balance", distribution.quantilesRaw.p25, "raw token units"],
    ["holders.distribution.quantile_p50_raw", "Nearest-rank p50 balance", distribution.quantilesRaw.p50, "raw token units"],
    ["holders.distribution.quantile_p75_raw", "Nearest-rank p75 balance", distribution.quantilesRaw.p75, "raw token units"],
    ["holders.distribution.quantile_p90_raw", "Nearest-rank p90 balance", distribution.quantilesRaw.p90, "raw token units"],
    ["holders.distribution.quantile_p99_raw", "Nearest-rank p99 balance", distribution.quantilesRaw.p99, "raw token units"],
    ["holders.distribution.distinct_balance_count", "Distinct positive balance count", distribution.distinctBalanceCount, "balance values"],
    ["holders.distribution.repeated_balance_group_count", "Repeated exact-balance group count", distribution.repeatedBalanceGroupCount, "groups"],
    ["holders.distribution.authorities_in_repeated_balance_groups", "Authorities in repeated exact-balance groups", distribution.authoritiesInRepeatedBalanceGroups, "owner authorities"],
    ["holders.distribution.authority_share_in_repeated_balance_groups", "Authority share in repeated exact-balance groups", distribution.authorityShareInRepeatedBalanceGroups, "percent"],
    ["holders.distribution.cumulative_profile", "Cumulative ascending-balance profile", distribution.cumulativeOwnerBalanceProfile, null],
    ["holders.distribution.repeated_balance_groups", "Repeated exact-balance groups (bounded source listing)", distribution.repeatedBalanceGroups, null],
  ];
  for (const [id, label, value, unit] of facts) {
    const emptyNull = distribution.observedOwnerAuthorityCount === 0 && value === null;
    entries.push(emptyNull
      ? entry(id, label, "unavailable", null, unit, distributionSource, { reason: "empty_observed_population", completeness: distributionCompleteness, limitation: "No positive owner-authority observations were present." })
      : entry(id, label, "available", value, unit, distributionSource, { completeness: distributionCompleteness, measurementBasis: "Existing owner-authority distribution normalizer; no values recalculated.", limitation: "Descriptive distribution only; repeated/small balances do not establish behavior." }));
  }
  return entries;
}

function controlsEntries(report: SolanaTokenEvidenceReport): SolanaQualificationMetricEvidenceEntry[] {
  const ids = [
    ["token_controls.token_program", "Token program"], ["token_controls.mint_authority_state", "Base mint-authority state"],
    ["token_controls.mint_authority_address", "Base mint-authority address"], ["token_controls.freeze_authority_state", "Base freeze-authority state"],
    ["token_controls.freeze_authority_address", "Base freeze-authority address"], ["token_controls.mint_extension_inventory", "Recognized Token-2022 mint extension inventory"],
  ] as const;
  const section = report.mint;
  if (section.status !== "present") {
    const failure = failedSection(section)!;
    return ids.map(([id, label]) => entry(id, label, failure.status, null, null, source("mint", "report.mint"), { reason: failure.reason }));
  }
  const resolution = section.evidence.resolution;
  const mintSource = source("mint", "report.mint.evidence.resolution", { provider: "helius", method: "getAccountInfo" });
  if (!resolution.exists || !resolution.isMint) return ids.map(([id, label]) => entry(id, label, "not_applicable", null, null, mintSource, { reason: "asset_not_a_supported_mint" }));
  if (!("token2022MintExtensionInventory" in section.evidence)) fail();
  const inventory = section.evidence.token2022MintExtensionInventory;
  const authority = (which: "mintAuthority" | "freezeAuthority", role: "mint" | "freeze") => {
    const evidence = resolution.baseAuthorities[which];
    const ref = source("mint", `report.mint.evidence.resolution.baseAuthorities.${which}`, { provider: "helius", method: "getAccountInfo" });
    return [
      entry(`token_controls.${role}_authority_state` as SolanaQualificationMetricId, `Base ${role}-authority state`, "available", evidence.status, null, ref, { measurementBasis: "SPL base mint COption field only", limitation: "Not observed authority behavior or complete Token-2022 security coverage." }),
      entry(`token_controls.${role}_authority_address` as SolanaQualificationMetricId, `Base ${role}-authority address`, evidence.status === "unset" ? "unavailable" : "available", evidence.address, null, ref, { reason: evidence.status === "unset" ? "authority_unset" : null, measurementBasis: "SPL base mint COption field; unset authority bytes are ignored.", limitation: "Configured address does not establish beneficial ownership or future action." }),
    ];
  };
  const inventoryEntry = inventory.status === "available"
    ? entry("token_controls.mint_extension_inventory", "Recognized Token-2022 mint extension inventory", "available", inventory.extensions, null, source("mint", "report.mint.evidence.token2022MintExtensionInventory.extensions"), { measurementBasis: "Recognized mint extension IDs/names/payload lengths.", limitation: "Inventory only; no extension authorities or complete security/control coverage." })
    : inventory.status === "not_applicable"
      ? entry("token_controls.mint_extension_inventory", "Recognized Token-2022 mint extension inventory", "not_applicable", null, null, source("mint", "report.mint.evidence.token2022MintExtensionInventory"), { reason: "classic_spl_token_program" })
      : entry("token_controls.mint_extension_inventory", "Recognized Token-2022 mint extension inventory", "malformed", null, null, source("mint", "report.mint.evidence.token2022MintExtensionInventory"), { reason: inventory.reason });
  return [
    entry("token_controls.token_program", "Token program", "available", resolution.tokenProgram, null, mintSource, { measurementBasis: "Resolved mint account owner program." }),
    ...authority("mintAuthority", "mint"), ...authority("freezeAuthority", "freeze"), inventoryEntry,
  ];
}

function historicalEntries(report: SolanaTokenEvidenceReport): SolanaQualificationMetricEvidenceEntry[] {
  const section = report.historicalTransactions;
  if (section.status !== "present") {
    const failure = failedSection(section)!;
    const base = entry("historical.request_state", "Historical request state", failure.status, null, null, source("historicalTransactions", "report.historicalTransactions"), { reason: failure.reason });
    return [base];
  }
  const evidence = section.evidence;
  const metrics = evidence.descriptiveMetrics;
  const plan = evidence.queryPlan;
  const observedAt = evidence.execution.evidence.provenance.fetchedAt;
  const common = { provider: evidence.execution.evidence.provenance.provider, method: evidence.execution.evidence.provenance.method, observedAt };
  const out = [
    entry("historical.request_state", "Historical request state", "available", "requested", null, source("historicalTransactions", "report.historicalTransactions", common), { measurementBasis: "Report request state." }),
    entry("historical.requested_window", "Requested historical window", "available", { fromUnixSecondsInclusive: plan.requestedWindow.fromUnixSecondsInclusive, toUnixSecondsExclusive: plan.requestedWindow.toUnixSecondsExclusive }, "Unix seconds", source("historicalTransactions", "report.historicalTransactions.evidence.queryPlan.requestedWindow", common), { measurementBasis: "Inclusive start and exclusive end; requested window is not observed time coverage.", completeness: "complete" }),
    entry("historical.sample_coverage", "Historical authority sample coverage", "available", metrics.sampleCoverage, "authority counts", source("historicalTransactions", "report.historicalTransactions.evidence.descriptiveMetrics.sampleCoverage", common), { measurementBasis: "Existing bounded authority sample summary.", completeness: metrics.source.candidateSetCompleteness === "complete" ? "complete" : "partial", limitation: "Selected/queried authorities are not the full holder population or mint-wide activity." }),
  ];
  const fields = [
    ["acceptedObservationCount", "historical.authority.accepted_observation_count", "Retained transfer observation-row count", "rows"],
    ["distinctSignatureCount", "historical.authority.distinct_signature_count", "Distinct observed transaction signature count", "signatures"],
    ["observedBlockTimeBounds", "historical.authority.observed_block_time_bounds", "Observed returned-record block-time bounds", "Unix seconds"],
    ["missingBlockTimeCount", "historical.authority.missing_block_time_count", "Records without usable block time", "rows"],
    ["reportedTransferTypeCounts", "historical.authority.transfer_type_counts", "Reported transfer-type counts", "rows"],
    ["reportedEndpointRelationshipCounts", "historical.authority.endpoint_relationship_counts", "Reported endpoint relationships relative to queried authority", "rows"],
    ["amountEvidenceProfile", "historical.authority.amount_evidence_profile", "Exact/non-exact raw amount evidence profile", "rows"],
  ] as const;
  for (let index = 0; index < metrics.authorities.length; index += 1) {
    const authority = metrics.authorities[index]!;
    for (const [field, idValue, label, unit] of fields) {
      const metric = authority[field] as SolanaHistoricalMetricValue<unknown>;
      const id = idValue as SolanaQualificationMetricId;
      const path = `report.historicalTransactions.evidence.descriptiveMetrics.authorities[${index}].${field}`;
      const metricSource = source("historicalTransactions", path, common);
      const scope = { kind: "authority" as const, address: authority.authorityAddress };
      if (metric.status === "unavailable") {
        out.push(entry(id, label, "unavailable", null, unit, metricSource, { reason: metric.reason, scope }));
      } else {
        out.push(entry(id, label, "available", metric.value, unit, metricSource, {
          completeness: metric.queryCompleteness,
          measurementBasis: field === "acceptedObservationCount" ? "Retained observation rows; no deduplication."
            : field === "distinctSignatureCount" ? "Distinct signatures among retained observation rows."
              : field === "observedBlockTimeBounds" ? "Minimum/maximum usable times among returned records; no provider-order assumption."
                : field === "reportedEndpointRelationshipCounts" ? "Provider-reported endpoints relative to this queried authority; not trade direction."
                  : "Existing historical descriptive-metrics calculator; no additional amount aggregation.",
          limitation: authority.paginationStatus === "truncated" || authority.queryStatus === "provider_error"
            ? "Partial accepted observations; no full-window or mint-wide activity claim."
            : "Specific queried authority and requested interval only; natural termination is not lifetime completeness.", scope,
        }));
      }
    }
  }
  const integration = evidence.transactionIntegration.coverage.downstream.status;
  const integrationStatus: SolanaQualificationMetricStatus = integration === "conflicting" ? "conflicting"
    : integration === "unavailable" ? "unavailable" : integration === "not_applicable" ? "not_applicable" : "available";
  out.push(entry("historical.transaction_integration_coverage", "Selected transaction evidence integration coverage", integrationStatus, integration, null, source("historicalTransactions", "report.historicalTransactions.evidence.transactionIntegration.coverage.downstream"), { reason: integration === "conflicting" ? "source_conflict" : null, limitation: "Applies only to selected transaction candidates; does not establish trade effects or mint-wide activity." }));
  return out;
}

/** Purely projects normalized report facts into a stable, non-scoring metric-evidence ledger. */
export function deriveSolanaQualificationMetricEvidence(report: SolanaTokenEvidenceReport): SolanaQualificationMetricEvidence {
  assertReport(report);
  const market = report.market;
  let pool: NormalizedPoolMarket | null = null;
  if (market.status === "present" && market.evidence.primaryPoolAddress !== null) {
    pool = market.evidence.pools.find((candidate) => candidate.poolAddress === market.evidence.primaryPoolAddress) ?? null;
    if (!pool) fail();
  }
  const poolIndex = pool === null || market.status !== "present" ? -1 : market.evidence.pools.indexOf(pool);
  const entries = [
    marketMetric("market.primary_pool.liquidity_usd", "Selected-pool reported USD liquidity", pool?.liquidityUsd ?? null, report, pool, `report.market.evidence.pools[${poolIndex}].liquidityUsd`),
    marketMetric("market.primary_pool.volume_h24_usd", "Selected-pool reported 24-hour USD volume", pool?.volumeUsd.h24 ?? null, report, pool, `report.market.evidence.pools[${poolIndex}].volumeUsd.h24`),
    marketMetric("market.primary_pool.price_usd", "Selected-pool reported token USD price", pool?.priceUsd ?? null, report, pool, `report.market.evidence.pools[${poolIndex}].priceUsd`),
    marketMetric("market.primary_pool.market_cap_usd", "Selected-pool reported USD market capitalization", pool?.marketCapUsd ?? null, report, pool, `report.market.evidence.pools[${poolIndex}].marketCapUsd`),
    marketMetric("market.primary_pool.fdv_usd", "Selected-pool reported USD fully diluted valuation", pool?.fdvUsd ?? null, report, pool, `report.market.evidence.pools[${poolIndex}].fdvUsd`),
    ...holderEntries(report), ...controlsEntries(report), ...historicalEntries(report),
  ];
  return {
    schemaVersion: SOLANA_QUALIFICATION_METRIC_EVIDENCE_SCHEMA_VERSION,
    chain: "solana", mintAddress: report.assetAddress,
    sourceReportSchemaVersion: report.schemaVersion, sourceReportGeneratedAt: report.generatedAt,
    entries,
  };
}
