import type { SolanaTokenEvidenceReport, SolanaHistoricalReportEvidence, EvidenceSection } from "../types/solanaTokenEvidenceReport";
import type {
  SolanaHistoricalAuthorityMetrics,
  SolanaHistoricalMetricValue,
} from "../types/solanaHistoricalMetrics";
import type { NormalizedPoolMarket } from "../types/market";
import type { HolderConcentration } from "../types/holders";
import type {
  SolanaPresentationCompleteness,
  SolanaPresentationField,
  SolanaPresentationProvenance,
  SolanaPresentationSourceStatus,
  SolanaPresentationValue,
  SolanaPresentationValueBasis,
  SolanaPresentationValueStatus,
  SolanaTokenEvidencePresentationV1,
  SolanaPresentationConcentration,
  SolanaHistoricalAuthorityPresentation,
  SolanaHistoricalPagePresentation,
  SolanaHistoricalTransactionPresentation,
} from "../types/solanaTokenEvidencePresentation";
import { SOLANA_TOKEN_EVIDENCE_PRESENTATION_SCHEMA_VERSION } from "../types/solanaTokenEvidencePresentation";

const CROSS_SECTION_TIMING_LIMITATION =
  "Mint, market, holder, and historical observations can originate from different acquisition times or context slots; this assembled report is not an atomic, same-time or same-slot snapshot.";
const PRIMARY_POOL_SELECTION_LIMITATION =
  "Primary-pool selection is for deterministic reporting: available USD liquidity is considered first, then available 24-hour USD volume, then pool address; the selected pool is not guaranteed to represent every market or to be the best trading venue.";
const UNADJUSTED_HOLDER_LIMITATION =
  "The presented owner-authority distribution and concentration are unadjusted; no LP, pool, treasury, custodial, or other unresolved roles are excluded.";

type FieldInput = {
  id: SolanaPresentationField["id"];
  label: string;
  status: SolanaPresentationValueStatus;
  value: SolanaPresentationValue;
  rawValue: SolanaPresentationValue;
  displayValue: string | null;
  unit?: string | null;
  denominatorDescription?: string | null;
  reason?: string | null;
  sourceField?: string | null;
  provenance: SolanaPresentationProvenance;
};

function field(input: FieldInput): SolanaPresentationField {
  return {
    id: input.id,
    label: input.label,
    status: input.status,
    value: input.value,
    rawValue: input.rawValue,
    displayValue: input.displayValue,
    unit: input.unit ?? null,
    denominatorDescription: input.denominatorDescription ?? null,
    reason: input.reason ?? null,
    sourceField: input.sourceField ?? null,
    provenance: input.provenance,
  };
}

function provenance(
  sourcePath: string,
  valueBasis: SolanaPresentationValueBasis,
  options: Partial<Pick<SolanaPresentationProvenance, "provider" | "method" | "observedAt" | "sourceUpdatedAt" | "contextSlots">> = {},
): SolanaPresentationProvenance {
  return {
    sourcePath,
    provider: options.provider ?? null,
    method: options.method ?? null,
    observedAt: options.observedAt ?? null,
    sourceUpdatedAt: options.sourceUpdatedAt ?? null,
    contextSlots: options.contextSlots == null ? null : [...options.contextSlots],
    valueBasis,
  };
}

function sourceStatus(section: EvidenceSection<unknown> | { status: "not_requested" }): SolanaPresentationSourceStatus {
  if (section.status === "unavailable") {
    return {
      status: "unavailable",
      reason: section.reason,
      ...(section.errorCategory === undefined ? {} : { errorCategory: section.errorCategory }),
    };
  }
  if (section.status === "not_attempted") return { status: "not_attempted", reason: section.reason };
  if (section.status === "not_requested") return { status: "not_requested" };
  return { status: "present" };
}

function unknownField(
  id: SolanaPresentationField["id"],
  label: string,
  reason: string,
  sourcePath: string,
): SolanaPresentationField {
  return field({
    id,
    label,
    status: "unknown",
    value: null,
    rawValue: null,
    displayValue: null,
    reason,
    provenance: provenance(sourcePath, "source_report"),
  });
}

function directField(
  id: SolanaPresentationField["id"],
  label: string,
  value: SolanaPresentationValue,
  sourcePath: string,
  displayValue: string | null = value === null ? null : String(value),
  options: {
    unit?: string | null;
    denominatorDescription?: string | null;
    valueBasis?: SolanaPresentationValueBasis;
    provider?: string | null;
    method?: string | null;
    observedAt?: string | null;
    sourceUpdatedAt?: string | null;
    contextSlots?: number[] | null;
    sourceField?: string | null;
    /** Required for null source values so their meaning is never assumed. */
    nullSemantics?: {
      status: SolanaPresentationValueStatus;
      reason: string | null;
      displayValue: string | null;
    };
  } = {},
): SolanaPresentationField {
  if (value === null && options.nullSemantics === undefined) {
    throw new Error("Null presentation values require explicit source semantics.");
  }
  return field({
    id,
    label,
    status: value === null ? options.nullSemantics!.status : "available",
    value,
    rawValue: value,
    displayValue: value === null ? options.nullSemantics!.displayValue : displayValue,
    unit: options.unit,
    denominatorDescription: options.denominatorDescription,
    reason: value === null ? options.nullSemantics!.reason : null,
    provenance: provenance(sourcePath, options.valueBasis ?? "source_report", options),
  });
}

function unavailableField(
  id: SolanaPresentationField["id"],
  label: string,
  reason: string,
  sourcePath: string,
  options: {
    provider?: string | null;
    method?: string | null;
    observedAt?: string | null;
    sourceUpdatedAt?: string | null;
    contextSlots?: number[] | null;
  } = {},
): SolanaPresentationField {
  return field({
    id,
    label,
    status: "unavailable",
    value: null,
    rawValue: null,
    displayValue: null,
    reason,
    sourceField: null,
    provenance: provenance(sourcePath, "source_report", options),
  });
}

function resolutionFields(report: SolanaTokenEvidenceReport): SolanaPresentationField[] {
  const path = "report.mint";
  const requested = directField("identity.requested_mint_address", "Requested mint address", report.assetAddress, "report.assetAddress");
  if (report.mint.status !== "present") {
    const reason = report.mint.status === "unavailable" ? report.mint.reason : "mint_not_resolved";
    return [requested,
      unavailableField("identity.resolved_mint_address", "Resolved mint address", reason, `${path}.evidence.resolution`),
      unavailableField("identity.account_exists", "On-chain account exists", reason, `${path}.evidence.resolution`),
      unavailableField("identity.is_mint", "Resolved as token mint", reason, `${path}.evidence.resolution`),
      unavailableField("identity.token_program", "Token program", reason, `${path}.evidence.resolution`),
      unavailableField("identity.decimals", "Decimals", reason, `${path}.evidence.resolution`),
      unavailableField("identity.raw_supply", "Raw supply", reason, `${path}.evidence.resolution`),
      unavailableField("identity.mint_authority_status", "Base mint authority state", reason, `${path}.evidence.resolution`),
      unavailableField("identity.mint_authority_address", "Base mint authority address", reason, `${path}.evidence.resolution`),
      unavailableField("identity.freeze_authority_status", "Base freeze authority state", reason, `${path}.evidence.resolution`),
      unavailableField("identity.freeze_authority_address", "Base freeze authority address", reason, `${path}.evidence.resolution`),
      unavailableField("identity.extension_inventory_status", "Token-2022 mint extension inventory", reason, `${path}.evidence.token2022MintExtensionInventory`),
    ];
  }

  const evidence = report.mint.evidence;
  const resolution = evidence.resolution;
  if (!resolution.exists || !resolution.isMint) {
    const detail = resolution.exists ? "Address exists but is not a supported token mint" : "No on-chain account was found";
    return [requested,
      unavailableField("identity.resolved_mint_address", "Resolved mint address", detail, `${path}.evidence.resolution`),
      directField("identity.account_exists", "On-chain account exists", resolution.exists, `${path}.evidence.resolution.exists`),
      directField("identity.is_mint", "Resolved as token mint", resolution.isMint, `${path}.evidence.resolution.isMint`),
      unavailableField("identity.token_program", "Token program", detail, `${path}.evidence.resolution`),
      unavailableField("identity.decimals", "Decimals", detail, `${path}.evidence.resolution`),
      unavailableField("identity.raw_supply", "Raw supply", detail, `${path}.evidence.resolution`),
      unavailableField("identity.mint_authority_status", "Base mint authority state", detail, `${path}.evidence.resolution`),
      unavailableField("identity.mint_authority_address", "Base mint authority address", detail, `${path}.evidence.resolution`),
      unavailableField("identity.freeze_authority_status", "Base freeze authority state", detail, `${path}.evidence.resolution`),
      unavailableField("identity.freeze_authority_address", "Base freeze authority address", detail, `${path}.evidence.resolution`),
      unavailableField("identity.extension_inventory_status", "Token-2022 mint extension inventory", detail, `${path}.evidence.token2022MintExtensionInventory`),
    ];
  }

  if (!("token2022MintExtensionInventory" in evidence)) {
    return [requested,
      directField("identity.resolved_mint_address", "Resolved mint address", resolution.mintAddress, `${path}.evidence.resolution.mintAddress`),
      directField("identity.account_exists", "On-chain account exists", resolution.exists, `${path}.evidence.resolution.exists`),
      directField("identity.is_mint", "Resolved as token mint", resolution.isMint, `${path}.evidence.resolution.isMint`),
      directField("identity.token_program", "Token program", resolution.tokenProgram, `${path}.evidence.resolution.tokenProgram`),
      directField("identity.decimals", "Decimals", resolution.decimals, `${path}.evidence.resolution.decimals`, String(resolution.decimals), { unit: "decimal places" }),
      directField("identity.raw_supply", "Raw supply", resolution.rawSupply, `${path}.evidence.resolution.rawSupply`, resolution.rawSupply, { unit: "raw token units" }),
      unknownField("identity.mint_authority_status", "Base mint authority state", "base_authority_not_present_in_source", `${path}.evidence.resolution.baseAuthorities.mintAuthority`),
      unknownField("identity.mint_authority_address", "Base mint authority address", "base_authority_not_present_in_source", `${path}.evidence.resolution.baseAuthorities.mintAuthority`),
      unknownField("identity.freeze_authority_status", "Base freeze authority state", "base_authority_not_present_in_source", `${path}.evidence.resolution.baseAuthorities.freezeAuthority`),
      unknownField("identity.freeze_authority_address", "Base freeze authority address", "base_authority_not_present_in_source", `${path}.evidence.resolution.baseAuthorities.freezeAuthority`),
      unknownField("identity.extension_inventory_status", "Token-2022 mint extension inventory", "inventory_not_present_in_source", `${path}.evidence.token2022MintExtensionInventory`),
    ];
  }
  const authorityPath = `${path}.evidence.resolution.baseAuthorities`;
  const mintAuthority = resolution.baseAuthorities.mintAuthority;
  const freezeAuthority = resolution.baseAuthorities.freezeAuthority;
  const authorityFields = (which: "mintAuthority" | "freezeAuthority", value: typeof mintAuthority, label: string): SolanaPresentationField[] => [
    directField(`identity.${which === "mintAuthority" ? "mint" : "freeze"}_authority_status`, `${label} state`, value.status,
      `${authorityPath}.${which}.status`, value.status === "unset" ? "Unset" : "Set"),
    directField(`identity.${which === "mintAuthority" ? "mint" : "freeze"}_authority_address`, `${label} address`, value.address,
      `${authorityPath}.${which}.address`, value.address ?? "Unset", value.address === null
        ? { nullSemantics: { status: "available", reason: "authority_unset", displayValue: "Unset" } }
        : {}),
  ];
  return [
    requested,
    directField("identity.resolved_mint_address", "Resolved mint address", resolution.mintAddress, `${path}.evidence.resolution.mintAddress`),
    directField("identity.account_exists", "On-chain account exists", resolution.exists, `${path}.evidence.resolution.exists`),
    directField("identity.is_mint", "Resolved as token mint", resolution.isMint, `${path}.evidence.resolution.isMint`),
    directField("identity.token_program", "Token program", resolution.tokenProgram, `${path}.evidence.resolution.tokenProgram`),
    directField("identity.decimals", "Decimals", resolution.decimals, `${path}.evidence.resolution.decimals`, String(resolution.decimals), { unit: "decimal places" }),
    directField("identity.raw_supply", "Raw supply", resolution.rawSupply, `${path}.evidence.resolution.rawSupply`, resolution.rawSupply, { unit: "raw token units" }),
    ...authorityFields("mintAuthority", mintAuthority, "Base mint authority"),
    ...authorityFields("freezeAuthority", freezeAuthority, "Base freeze authority"),
    directField("identity.extension_inventory_status", "Token-2022 mint extension inventory", evidence.token2022MintExtensionInventory.status, `${path}.evidence.token2022MintExtensionInventory.status`),
  ];
}

function identitySection(report: SolanaTokenEvidenceReport) {
  const evidence = report.mint.status === "present" ? report.mint.evidence : null;
  const inventory = evidence && evidence.resolution.exists && evidence.resolution.isMint && "token2022MintExtensionInventory" in evidence
    ? evidence.token2022MintExtensionInventory
    : null;
  const completeness: SolanaPresentationCompleteness = "not_established";
  const limitations = ["Base authority fields do not describe Token-2022 extension authorities or provide a security assessment."];
  if (!inventory) limitations.push("No mint extension inventory is available for this mint outcome.");
  else if (inventory.status === "malformed") limitations.push("The Token-2022 extension inventory is malformed; extension contents are not presented.");
  else if (inventory.status === "available" && inventory.extensions.length > 0) {
    limitations.push("The inventory lists extension types and payload lengths only; it does not establish complete authority or security coverage.");
  }
  return {
    id: "identity_mint" as const,
    label: "Identity and mint",
    sourceStatus: sourceStatus(report.mint),
    completeness,
    limitations,
    fields: resolutionFields(report),
    extensionInventoryProvenance: provenance("report.mint.evidence.token2022MintExtensionInventory", "source_report"),
    extensions: {
      status: inventory?.status ?? "not_available" as const,
      entries: inventory?.status === "available" ? inventory.extensions.map((entry) => ({
        extensionTypeId: entry.extensionTypeId,
        extensionName: entry.extensionName,
        payloadLength: entry.payloadLength,
      })) : [],
      reason: inventory?.status === "malformed" ? inventory.reason : inventory ? null : "mint_not_resolved",
      limitation: "Presence inventory only; it is not a complete Token-2022 authority/security analysis.",
    },
  };
}

function metricField(
  id: SolanaPresentationField["id"],
  label: string,
  metric: { status: "available"; value: string | number; basis: "provider_reported" | "calculated"; sourceField?: string }
    | { status: "unavailable"; value: null; reason: string },
  sourcePath: string,
  provider: "dexscreener",
  observedAt: string,
  sourceUpdatedAt: string | null = null,
): SolanaPresentationField {
  if (metric.status === "unavailable") return unavailableField(id, label, metric.reason, `${sourcePath}.reason`, { provider, method: "token-pairs", observedAt, sourceUpdatedAt });
  const unit = id === "market.price_usd" ? "USD per token"
    : id === "market.token_age_seconds" ? "seconds"
      : id === "market.pool_created_at" || id === "market.token_created_at" ? "ISO 8601 time"
        : id.startsWith("market.volume_") || id === "market.market_cap_usd" || id === "market.fdv_usd" || id === "market.liquidity_usd" ? "USD" : null;
  return {
    ...directField(id, label, metric.value, `${sourcePath}.value`, String(metric.value), {
    provider,
    method: "token-pairs",
    observedAt,
    sourceUpdatedAt,
    valueBasis: metric.basis,
    }),
    sourceField: metric.sourceField ?? null,
    unit,
  };
}

function poolFields(pool: NormalizedPoolMarket, index: number): SolanaPresentationField[] {
  const root = `report.market.evidence.pools[${index}]`;
  const poolFetchedAt = pool.provenance.fetchedAt;
  return [
    pool.provenance.sourceUpdatedAt === null
      ? unavailableField("market.source_updated_at", "Provider source update time", "not_reported", `${root}.provenance.sourceUpdatedAt`, { provider: "dexscreener", method: "token-pairs", observedAt: poolFetchedAt })
      : directField("market.source_updated_at", "Provider source update time", pool.provenance.sourceUpdatedAt, `${root}.provenance.sourceUpdatedAt`, pool.provenance.sourceUpdatedAt, { provider: "dexscreener", method: "token-pairs", observedAt: poolFetchedAt, sourceUpdatedAt: pool.provenance.sourceUpdatedAt, unit: "ISO 8601 time" }),
    metricField("market.pool_created_at", "Pool creation time", pool.poolCreatedAt, `${root}.poolCreatedAt`, "dexscreener", poolFetchedAt, pool.provenance.sourceUpdatedAt),
    metricField("market.price_usd", "USD price", pool.priceUsd, `${root}.priceUsd`, "dexscreener", poolFetchedAt, pool.provenance.sourceUpdatedAt),
    metricField("market.market_cap_usd", "Market capitalization", pool.marketCapUsd, `${root}.marketCapUsd`, "dexscreener", poolFetchedAt, pool.provenance.sourceUpdatedAt),
    metricField("market.fdv_usd", "Fully diluted valuation", pool.fdvUsd, `${root}.fdvUsd`, "dexscreener", poolFetchedAt, pool.provenance.sourceUpdatedAt),
    metricField("market.liquidity_usd", "Reported pool USD liquidity", pool.liquidityUsd, `${root}.liquidityUsd`, "dexscreener", poolFetchedAt, pool.provenance.sourceUpdatedAt),
    metricField("market.volume_m5_usd", "Reported pool 5-minute USD volume", pool.volumeUsd.m5, `${root}.volumeUsd.m5`, "dexscreener", poolFetchedAt, pool.provenance.sourceUpdatedAt),
    metricField("market.volume_h1_usd", "Reported pool 1-hour USD volume", pool.volumeUsd.h1, `${root}.volumeUsd.h1`, "dexscreener", poolFetchedAt, pool.provenance.sourceUpdatedAt),
    metricField("market.volume_h6_usd", "Reported pool 6-hour USD volume", pool.volumeUsd.h6, `${root}.volumeUsd.h6`, "dexscreener", poolFetchedAt, pool.provenance.sourceUpdatedAt),
    metricField("market.volume_h24_usd", "Reported pool 24-hour USD volume", pool.volumeUsd.h24, `${root}.volumeUsd.h24`, "dexscreener", poolFetchedAt, pool.provenance.sourceUpdatedAt),
  ];
}

function marketSection(report: SolanaTokenEvidenceReport) {
  if (report.market.status !== "present") {
    const state = sourceStatus(report.market);
    return {
      id: "market" as const,
      label: "Market",
      sourceStatus: state,
      completeness: "not_established" as const,
      limitations: ["No market snapshot is present in the assembled report.", PRIMARY_POOL_SELECTION_LIMITATION],
      fields: [
        unknownField("market.source_updated_at", "Provider source update time", "market_snapshot_not_present", "report.market.evidence.provenance.sourceUpdatedAt"),
        unknownField("market.provider_fetch_time", "Market provider fetch time", "market_snapshot_not_present", "report.market.evidence.provenance.fetchedAt"),
        unknownField("market.pool_count", "Eligible pool count", "market_snapshot_not_present", "report.market.evidence.pools"),
        unknownField("market.primary_pool_address", "Deterministically selected primary pool", "market_snapshot_not_present", "report.market.evidence.primaryPoolAddress"),
        unknownField("market.token_created_at", "Token creation time", "market_snapshot_not_present", "report.market.evidence.tokenCreatedAt"),
        unknownField("market.token_age_seconds", "Token age", "market_snapshot_not_present", "report.market.evidence.tokenAgeSeconds"),
        unknownField("market.lifecycle_state", "Lifecycle state", "market_snapshot_not_present", "report.market.evidence.lifecycle.state"),
        unknownField("market.lifecycle_basis", "Lifecycle evidence basis", "market_snapshot_not_present", "report.market.evidence.lifecycle.basis"),
        unknownField("market.lifecycle_evidence", "Lifecycle evidence", "market_snapshot_not_present", "report.market.evidence.lifecycle.evidence"),
      ],
      pools: [],
      primaryPoolAddress: null,
    };
  }
  const snapshot = report.market.evidence;
  const path = "report.market.evidence";
  const fetchedAt = snapshot.provenance.fetchedAt;
  const providerProvenance = { provider: "dexscreener" as const, method: "token-pairs", observedAt: fetchedAt };
  const fields = [
    snapshot.provenance.sourceUpdatedAt === null
      ? unavailableField("market.source_updated_at", "Provider source update time", "not_reported", `${path}.provenance.sourceUpdatedAt`, providerProvenance)
      : directField("market.source_updated_at", "Provider source update time", snapshot.provenance.sourceUpdatedAt, `${path}.provenance.sourceUpdatedAt`, snapshot.provenance.sourceUpdatedAt, { ...providerProvenance, sourceUpdatedAt: snapshot.provenance.sourceUpdatedAt, unit: "ISO 8601 time" }),
    directField("market.provider_fetch_time", "Market provider fetch time", fetchedAt, `${path}.provenance.fetchedAt`, fetchedAt, { ...providerProvenance, unit: "ISO 8601 time" }),
    directField("market.pool_count", "Eligible pool count", snapshot.pools.length, `${path}.pools.length`, String(snapshot.pools.length), { unit: "pools", valueBasis: "deterministic_summary", ...providerProvenance }),
    snapshot.primaryPoolAddress === null
      ? snapshot.pools.length === 0
        ? directField("market.primary_pool_address", "Deterministically selected primary pool", null, `${path}.primaryPoolAddress`, "No primary pool selected", { valueBasis: "deterministic_summary", ...providerProvenance, nullSemantics: { status: "available", reason: "no_eligible_pools", displayValue: "No primary pool selected" } })
        : unknownField("market.primary_pool_address", "Deterministically selected primary pool", "primary_pool_not_reported", `${path}.primaryPoolAddress`)
      : directField("market.primary_pool_address", "Deterministically selected primary pool", snapshot.primaryPoolAddress, `${path}.primaryPoolAddress`, snapshot.primaryPoolAddress, { valueBasis: "deterministic_summary", ...providerProvenance }),
    metricField("market.token_created_at", "Token creation time", snapshot.tokenCreatedAt, `${path}.tokenCreatedAt`, "dexscreener", fetchedAt),
    metricField("market.token_age_seconds", "Token age", snapshot.tokenAgeSeconds, `${path}.tokenAgeSeconds`, "dexscreener", fetchedAt),
    directField("market.lifecycle_state", "Lifecycle state", snapshot.lifecycle.state, `${path}.lifecycle.state`, snapshot.lifecycle.state, {
      valueBasis: snapshot.lifecycle.basis === "provider_reported" ? "provider_reported" : "source_report",
      provider: snapshot.lifecycle.basis === "provider_reported" ? "dexscreener" : null,
      observedAt: snapshot.lifecycle.basis === "provider_reported" ? fetchedAt : null,
    }),
    directField("market.lifecycle_basis", "Lifecycle evidence basis", snapshot.lifecycle.basis, `${path}.lifecycle.basis`),
    snapshot.lifecycle.evidence === null
      ? unavailableField("market.lifecycle_evidence", "Lifecycle evidence", "not_reported", `${path}.lifecycle.evidence`)
      : directField("market.lifecycle_evidence", "Lifecycle evidence", snapshot.lifecycle.evidence, `${path}.lifecycle.evidence`),
  ];
  return {
    id: "market" as const,
    label: "Market",
    sourceStatus: sourceStatus(report.market),
    completeness: "not_established" as const,
    limitations: snapshot.pools.length === 0
      ? ["The successful market lookup returned no eligible pools; absence is not a reported zero market metric.", PRIMARY_POOL_SELECTION_LIMITATION]
      : ["Pool metrics remain per-pool observations; no cross-pool liquidity or volume aggregation is presented.", PRIMARY_POOL_SELECTION_LIMITATION],
    fields,
    pools: snapshot.pools.map((pool, index) => ({
      poolAddress: pool.poolAddress,
      dexId: pool.dexId,
      counterTokenAddress: pool.counterTokenAddress,
      provenance: provenance(`report.market.evidence.pools[${index}]`, "source_report", {
        provider: pool.provenance.provider,
        method: "token-pairs",
        observedAt: pool.provenance.fetchedAt,
        sourceUpdatedAt: pool.provenance.sourceUpdatedAt,
      }),
      fields: poolFields(pool, index),
    })),
    primaryPoolAddress: snapshot.primaryPoolAddress,
  };
}

type PresentationHolderConcentration = HolderConcentration | (Omit<Extract<HolderConcentration, { status: "unavailable" }>, "reason"> & { reason: "enumeration_incomplete" });

function concentration(value: PresentationHolderConcentration, contextSlots: number[], sourcePath: string): SolanaPresentationConcentration {
  const base = {
    topN: value.topN,
    denominatorRaw: value.denominatorRaw,
    denominatorBasis: "current_mint_supply" as const,
    denominatorDescription: "Current mint supply" as const,
    unit: "percent" as const,
    provenance: provenance(sourcePath, "calculated", { provider: "helius", method: "getProgramAccountsV2", contextSlots }),
  };
  return value.status === "available"
    ? { ...base, status: "available", numeratorRaw: value.numeratorRaw, percentage: value.percentage, reason: null }
    : { ...base, status: "unavailable", numeratorRaw: null, percentage: null, reason: value.reason };
}

function holderSection(report: SolanaTokenEvidenceReport) {
  if (report.holders.status !== "present") {
    return {
      id: "holders" as const,
      label: "Holders",
      sourceStatus: sourceStatus(report.holders),
      completeness: "not_established" as const,
      limitations: ["Holder evidence is not present in the assembled report.", UNADJUSTED_HOLDER_LIMITATION],
      fields: [
        unknownField("holders.token_account_count", "Observed token-account count", "holder_evidence_not_present", "report.holders.evidence.holderStructure.tokenAccountCount"),
        unknownField("holders.positive_balance_owner_authority_count", "Observed positive-balance owner-authority count", "holder_evidence_not_present", "report.holders.evidence.holderStructure.rawOwnerCount"),
      ],
      contextSlots: null,
      slotConsistency: null,
      unsupportedExtensionTypes: null,
      acquisition: null,
      concentration: null,
      balanceDistribution: null,
      balanceDistributionProvenance: null,
    };
  }
  const evidence = report.holders.evidence;
  const structure = evidence.holderStructure;
  const distribution = evidence.ownerAuthorityBalanceDistribution;
  const snapshot = evidence.snapshotRecord;
  const path = "report.holders.evidence.holderStructure";
  const source = snapshot.source;
  const contextSlots = [...structure.enumeration.contextSlots];
  const fields: SolanaPresentationField[] = [
    directField("holders.token_account_count", "Observed token-account count", structure.tokenAccountCount, `${path}.tokenAccountCount`, String(structure.tokenAccountCount), { unit: "token accounts", valueBasis: "deterministic_summary", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    directField("holders.nonzero_token_account_count", "Observed nonzero token-account count", structure.nonzeroTokenAccountCount, `${path}.nonzeroTokenAccountCount`, String(structure.nonzeroTokenAccountCount), { unit: "token accounts", valueBasis: "deterministic_summary", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    directField("holders.positive_balance_owner_authority_count", "Observed positive-balance owner-authority count", structure.rawOwnerCount, `${path}.rawOwnerCount`, String(structure.rawOwnerCount), { unit: "owner authorities", valueBasis: "deterministic_summary", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    directField("holders.current_mint_supply_raw", "Current mint supply", structure.currentMintSupplyRaw, `${path}.currentMintSupplyRaw`, structure.currentMintSupplyRaw, { unit: "raw token units", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    directField("holders.observed_positive_balance_raw", "Observed positive balance total", structure.observedPositiveBalanceRaw, `${path}.observedPositiveBalanceRaw`, structure.observedPositiveBalanceRaw, { unit: "raw token units", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    directField("holders.supply_difference_raw", "Supply minus observed positive balances", structure.supplyDifferenceRaw, `${path}.supplyDifferenceRaw`, structure.supplyDifferenceRaw, { unit: "raw token units", valueBasis: "calculated", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    directField("holders.enumeration_completeness", "Token-account enumeration", structure.enumeration.completeness, `${path}.enumeration.completeness`, structure.enumeration.completeness, { provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    directField("holders.amount_coverage_state", "Amount coverage", structure.amountCoverage.state, `${path}.amountCoverage.state`, structure.amountCoverage.state, { provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    structure.amountCoverage.reason === null && structure.amountCoverage.state === "complete"
      ? directField("holders.amount_coverage_reason", "Amount coverage reason", null, `${path}.amountCoverage.reason`, "No reported limitation", { provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots, nullSemantics: { status: "available", reason: null, displayValue: "No reported limitation" } })
      : typeof structure.amountCoverage.reason === "string"
        ? directField("holders.amount_coverage_reason", "Amount coverage reason", structure.amountCoverage.reason, `${path}.amountCoverage.reason`, structure.amountCoverage.reason, { provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots })
        : unknownField("holders.amount_coverage_reason", "Amount coverage reason", "coverage_reason_not_reported", `${path}.amountCoverage.reason`),
    directField("holders.page_count", "Pages in holder enumeration", structure.enumeration.pageCount, `${path}.enumeration.pageCount`, String(structure.enumeration.pageCount), { unit: "pages", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    distribution.minimumBalanceRaw === null
      ? unavailableField("holders.minimum_balance_raw", "Minimum positive owner-authority balance", "empty_population", "report.holders.evidence.ownerAuthorityBalanceDistribution.minimumBalanceRaw", { provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots })
      : directField("holders.minimum_balance_raw", "Minimum positive owner-authority balance", distribution.minimumBalanceRaw, "report.holders.evidence.ownerAuthorityBalanceDistribution.minimumBalanceRaw", distribution.minimumBalanceRaw, { unit: "raw token units", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    distribution.maximumBalanceRaw === null
      ? unavailableField("holders.maximum_balance_raw", "Maximum positive owner-authority balance", "empty_population", "report.holders.evidence.ownerAuthorityBalanceDistribution.maximumBalanceRaw", { provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots })
      : directField("holders.maximum_balance_raw", "Maximum positive owner-authority balance", distribution.maximumBalanceRaw, "report.holders.evidence.ownerAuthorityBalanceDistribution.maximumBalanceRaw", distribution.maximumBalanceRaw, { unit: "raw token units", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    distribution.medianBalanceRaw === null
      ? unavailableField("holders.median_balance_raw", "Median positive owner-authority balance", "empty_population", "report.holders.evidence.ownerAuthorityBalanceDistribution.medianBalanceRaw", { provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots })
      : directField("holders.median_balance_raw", "Median positive owner-authority balance", distribution.medianBalanceRaw, "report.holders.evidence.ownerAuthorityBalanceDistribution.medianBalanceRaw", distribution.medianBalanceRaw, { unit: "raw token units", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
    directField("holders.repeated_balance_group_count", "Repeated exact-balance group count", distribution.repeatedBalanceGroupCount, "report.holders.evidence.ownerAuthorityBalanceDistribution.repeatedBalanceGroupCount", undefined, { unit: "groups", valueBasis: "deterministic_summary" }),
    directField("holders.authorities_in_repeated_balance_groups", "Authorities in repeated exact-balance groups", distribution.authoritiesInRepeatedBalanceGroups, "report.holders.evidence.ownerAuthorityBalanceDistribution.authoritiesInRepeatedBalanceGroups", undefined, { unit: "owner authorities", valueBasis: "deterministic_summary" }),
    directField("holders.distinct_balance_count", "Distinct positive balance count", distribution.distinctBalanceCount, "report.holders.evidence.ownerAuthorityBalanceDistribution.distinctBalanceCount", undefined, { unit: "distinct balances", valueBasis: "deterministic_summary" }),
    distribution.authorityShareInRepeatedBalanceGroups === null
      ? unavailableField("holders.authority_share_in_repeated_balance_groups", "Share of observed authorities in repeated exact-balance groups", "empty_population", "report.holders.evidence.ownerAuthorityBalanceDistribution.authorityShareInRepeatedBalanceGroups", { provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots })
      : directField("holders.authority_share_in_repeated_balance_groups", "Share of observed authorities in repeated exact-balance groups", distribution.authorityShareInRepeatedBalanceGroups, "report.holders.evidence.ownerAuthorityBalanceDistribution.authorityShareInRepeatedBalanceGroups", `${distribution.authorityShareInRepeatedBalanceGroups}%`, { unit: "percent", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots }),
  ];
  for (const quantile of ["p25", "p50", "p75", "p90", "p99"] as const) {
    fields.push(distribution.quantilesRaw[quantile] === null ? unavailableField(
      `holders.${quantile}` as SolanaPresentationField["id"],
      `${quantile.toUpperCase()} positive owner-authority balance`,
      "empty_population",
      `report.holders.evidence.ownerAuthorityBalanceDistribution.quantilesRaw.${quantile}`,
      { provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots },
    ) : directField(
      `holders.${quantile}` as SolanaPresentationField["id"],
      `${quantile.toUpperCase()} positive owner-authority balance`,
      distribution.quantilesRaw[quantile],
      `report.holders.evidence.ownerAuthorityBalanceDistribution.quantilesRaw.${quantile}`,
      distribution.quantilesRaw[quantile],
      { unit: "raw token units", provider: source.provider, method: source.method, observedAt: structure.fetchedAt, contextSlots },
    ));
  }
  const top = structure.concentration;
  const coverageComplete = snapshot.acquisition.completeness === "complete" &&
    structure.enumeration.completeness === "complete" && structure.amountCoverage.state === "complete" &&
    distribution.coverage.state === "complete";
  return {
    id: "holders" as const,
    label: "Holders",
    sourceStatus: sourceStatus(report.holders),
    completeness: coverageComplete ? "complete" as const : "partial" as const,
    limitations: [
      "Population means positive-balance token-account owner authorities; it does not establish wallets, people, beneficial owners, or economic holders.",
      UNADJUSTED_HOLDER_LIMITATION,
      "Enumeration page context slots are preserved; they do not imply one atomic snapshot.",
      ...(structure.amountCoverage.unsupportedExtensionTypes.length > 0 ? ["Unsupported balance-affecting Token-2022 extensions limit amount coverage."] : []),
      ...(structure.amountCoverage.reason === "supply_inconsistency" ? ["Observed positive balances are inconsistent with current mint supply."] : []),
    ],
    fields,
    contextSlots,
    slotConsistency: structure.enumeration.slotConsistency,
    unsupportedExtensionTypes: [...structure.amountCoverage.unsupportedExtensionTypes],
    acquisition: {
      completeness: snapshot.acquisition.completeness,
      stopReason: snapshot.acquisition.stopReason,
      configuredMaxPages: snapshot.acquisition.configuredMaxPages,
      requestedPageSize: snapshot.acquisition.requestedPageSize,
    },
    concentration: [top.top1, top.top5, top.top10, top.top20].map((item, index) =>
      concentration(item, contextSlots, `${path}.concentration.top${[1, 5, 10, 20][index]}`)),
    balanceDistributionProvenance: provenance("report.holders.evidence.ownerAuthorityBalanceDistribution", "calculated", {
      provider: source.provider,
      method: source.method,
      observedAt: distribution.coverage.sourceSnapshotAt,
      contextSlots: [...distribution.coverage.contextSlots],
    }),
    balanceDistribution: {
      observedOwnerAuthorityCount: distribution.observedOwnerAuthorityCount,
      observedPositiveOwnerAuthorityBalanceRaw: distribution.observedPositiveOwnerAuthorityBalanceRaw,
      cumulativeOwnerBalanceProfile: distribution.cumulativeOwnerBalanceProfile.map((point) => ({
        ...point,
        cumulativeObservedBalanceShareUnit: "percent" as const,
        cumulativeObservedBalanceShareDenominator: "observed_positive_owner_authority_balance" as const,
      })),
      distinctBalanceCount: distribution.distinctBalanceCount,
      repeatedBalanceGroups: distribution.repeatedBalanceGroups.map((group) => ({ ...group })),
      repeatedBalanceGroupsOmitted: distribution.repeatedBalanceGroupsOmitted,
      coverage: {
        state: distribution.coverage.state,
        reason: distribution.coverage.amountCoverageReason,
      },
    },
  };
}

function metricNumber<T extends string | number | object>(metric: SolanaHistoricalMetricValue<T>): T | null {
  return metric.status === "available" ? metric.value : null;
}

type HistoricalMetricPresentationState = {
  status: "available" | "unavailable" | "unknown";
  reason: "not_queried" | "provider_error" | "no_usable_block_times" | "metrics_not_available" | null;
};

function historicalMetricState<T>(metric: SolanaHistoricalMetricValue<T> | undefined): HistoricalMetricPresentationState {
  if (metric === undefined) return { status: "unknown", reason: "metrics_not_available" };
  return metric.status === "available"
    ? { status: "available", reason: null }
    : { status: "unavailable", reason: metric.reason };
}

function presentAuthority(
  authority: SolanaHistoricalReportEvidence["execution"]["evidence"]["authorities"][number],
  index: number,
  plan: SolanaHistoricalReportEvidence["queryPlan"],
  metrics: SolanaHistoricalAuthorityMetrics | undefined,
  evidenceProvider: string,
  evidenceMethod: string,
  evidenceFetchedAt: string,
): SolanaHistoricalAuthorityPresentation {
  const candidate = plan.candidateAuthorities.find((entry) => entry.authorityAddress === authority.authorityAddress);
  const selected = candidate?.plannedDisposition.status === "selected" ? candidate.plannedDisposition : null;
  const m = metrics;
  const amount = m?.amountEvidenceProfile.status === "available" ? m.amountEvidenceProfile.value : null;
  const bounds = m ? metricNumber(m.observedBlockTimeBounds) : null;
  return {
    authorityAddress: authority.authorityAddress,
    provenance: provenance(`report.historicalTransactions.evidence.execution.evidence.authorities[${index}]`, "source_report", {
      provider: evidenceProvider,
      method: evidenceMethod,
      observedAt: evidenceFetchedAt,
    }),
    selectionPosition: selected?.selectionPosition ?? null,
    observedCandidateFrameRank: candidate?.observedCandidateFrameRank ?? null,
    queryStatus: authority.queryStatus,
    paginationStatus: authority.paginationStatus,
    terminalReason: authority.terminalReason,
    acceptedObservationCount: authority.observations.length,
  acceptedObservationCountBasis: "retained_observation_rows",
    pages: authority.pages.map((page): SolanaHistoricalPagePresentation => ({
      pageNumber: page.pageNumber,
      requestLimit: page.requestLimit,
      recordCount: page.recordCount,
      startRecordIndex: page.startRecordIndex,
      endRecordIndexExclusive: page.endRecordIndexExclusive,
      continuationTokenUsed: page.continuationTokenUsed,
      continuationTokenReturned: page.continuationTokenReturned,
      firstUsableBlockTime: page.firstUsableBlockTime,
      lastUsableBlockTime: page.lastUsableBlockTime,
      minimumUsableBlockTime: page.minimumUsableBlockTime,
      maximumUsableBlockTime: page.maximumUsableBlockTime,
      recordsWithoutUsableBlockTime: page.recordsWithoutUsableBlockTime,
    })),
    observedBlockTimeBounds: bounds,
    observedBlockTimeBoundsStatus: historicalMetricState(m?.observedBlockTimeBounds).status,
    observedBlockTimeBoundsReason: historicalMetricState(m?.observedBlockTimeBounds).reason,
    observedBlockTimeBoundsQueryCompleteness: m?.observedBlockTimeBounds.status === "available" ? m.observedBlockTimeBounds.queryCompleteness : null,
    distinctSignatureCount: m ? metricNumber(m.distinctSignatureCount) : null,
    distinctSignatureCountStatus: historicalMetricState(m?.distinctSignatureCount).status,
    distinctSignatureCountReason: historicalMetricState(m?.distinctSignatureCount).reason,
    distinctSignatureCountQueryCompleteness: m?.distinctSignatureCount.status === "available" ? m.distinctSignatureCount.queryCompleteness : null,
    amountEvidence: {
      status: amount ? "available" : "unavailable",
      reason: amount ? null : m?.amountEvidenceProfile.status === "unavailable" ? m.amountEvidenceProfile.reason : "metrics_not_available",
      queryCompleteness: amount ? m?.amountEvidenceProfile.status === "available" ? m.amountEvidenceProfile.queryCompleteness : null : null,
      exactRawAmountObservationCount: amount?.exactRawAmountObservationCount ?? null,
      nonExactOrUnavailableAmountObservationCount: amount?.nonExactOrUnavailableAmountObservationCount ?? null,
      exactRawAmountCoverage: amount?.exactRawAmountCoverage ?? null,
      minimumExactRawAmount: amount?.minimumExactRawAmount ?? null,
      maximumExactRawAmount: amount?.maximumExactRawAmount ?? null,
    },
  };
}

function historicalSection(report: SolanaTokenEvidenceReport) {
  const section = report.historicalTransactions;
  if (section.status !== "present") {
    return {
      id: "historical" as const,
      label: "Historical evidence",
      sourceStatus: sourceStatus(section),
      completeness: "not_established" as const,
      limitations: section.status === "not_requested" ? ["Historical evidence was not requested."] : ["Historical evidence is not present in the assembled report."],
      fields: [],
      requestedWindow: null,
      authorities: [],
      transactions: [],
    };
  }
  const history = section.evidence;
  const evidence = history.execution.evidence;
  const metrics = history.descriptiveMetrics;
  const plan = history.queryPlan;
  const selection = history.transactionSelection;
  const enrichment = history.transactionEnrichment;
  const integration = history.transactionIntegration;
  const scope = evidence.authorityScope;
  const sample = metrics.sampleCoverage;
  const provenanceOptions = { provider: "helius" as const, method: evidence.provenance.method, observedAt: evidence.provenance.fetchedAt };
  const fields: SolanaPresentationField[] = [
    directField("historical.window_start_inclusive", "Requested window start (inclusive)", evidence.provenance.requestedWindow.fromUnixSecondsInclusive, "report.historicalTransactions.evidence.execution.evidence.provenance.requestedWindow.fromUnixSecondsInclusive", String(evidence.provenance.requestedWindow.fromUnixSecondsInclusive), { unit: "Unix seconds", ...provenanceOptions }),
    directField("historical.window_end_exclusive", "Requested window end (exclusive)", evidence.provenance.requestedWindow.toUnixSecondsExclusive, "report.historicalTransactions.evidence.execution.evidence.provenance.requestedWindow.toUnixSecondsExclusive", String(evidence.provenance.requestedWindow.toUnixSecondsExclusive), { unit: "Unix seconds", ...provenanceOptions }),
    directField("historical.provider_fetch_time", "Application query fetch time", evidence.provenance.fetchedAt, "report.historicalTransactions.evidence.execution.evidence.provenance.fetchedAt", evidence.provenance.fetchedAt, { unit: "ISO 8601 time", ...provenanceOptions }),
    scope.candidateAuthorityCount === null
      ? unknownField("historical.candidate_authority_count", "Candidate authority count", "candidate_count_unknown", "report.historicalTransactions.evidence.execution.evidence.authorityScope.candidateAuthorityCount")
      : directField("historical.candidate_authority_count", "Candidate authority count", scope.candidateAuthorityCount, "report.historicalTransactions.evidence.execution.evidence.authorityScope.candidateAuthorityCount", String(scope.candidateAuthorityCount), { unit: "owner authorities", ...provenanceOptions }),
    directField("historical.candidate_set_completeness", "Candidate-set completeness", scope.candidateSetCompleteness, "report.historicalTransactions.evidence.execution.evidence.authorityScope.candidateSetCompleteness", scope.candidateSetCompleteness, { ...provenanceOptions }),
    directField("historical.selected_authority_count", "Selected authority count", sample.selectedAuthorityCount, "report.historicalTransactions.evidence.descriptiveMetrics.sampleCoverage.selectedAuthorityCount", String(sample.selectedAuthorityCount), { unit: "owner authorities", valueBasis: "deterministic_summary", ...provenanceOptions }),
    directField("historical.queried_authority_count", "Queried authority count", sample.queriedAuthorityCount, "report.historicalTransactions.evidence.descriptiveMetrics.sampleCoverage.queriedAuthorityCount", String(sample.queriedAuthorityCount), { unit: "owner authorities", ...provenanceOptions }),
    directField("historical.naturally_complete_authority_count", "Naturally completed authority queries", sample.naturallyCompleteAuthorityCount, "report.historicalTransactions.evidence.descriptiveMetrics.sampleCoverage.naturallyCompleteAuthorityCount", String(sample.naturallyCompleteAuthorityCount), { unit: "owner authorities", ...provenanceOptions }),
    directField("historical.truncated_authority_count", "Truncated authority queries", sample.truncatedAuthorityCount, "report.historicalTransactions.evidence.descriptiveMetrics.sampleCoverage.truncatedAuthorityCount", String(sample.truncatedAuthorityCount), { unit: "owner authorities", ...provenanceOptions }),
    directField("historical.provider_error_authority_count", "Authority queries with provider errors", sample.providerErrorAuthorityCount, "report.historicalTransactions.evidence.descriptiveMetrics.sampleCoverage.providerErrorAuthorityCount", String(sample.providerErrorAuthorityCount), { unit: "owner authorities", ...provenanceOptions }),
    directField("historical.unqueried_authority_count", "Unqueried authorities", sample.unqueriedAuthorityCount, "report.historicalTransactions.evidence.descriptiveMetrics.sampleCoverage.unqueriedAuthorityCount", String(sample.unqueriedAuthorityCount), { unit: "owner authorities", ...provenanceOptions }),
    directField("historical.max_authorities", "Configured maximum selected authorities", evidence.provenance.maxAuthorities, "report.historicalTransactions.evidence.execution.evidence.provenance.maxAuthorities", String(evidence.provenance.maxAuthorities), { unit: "owner authorities", ...provenanceOptions }),
    directField("historical.max_provider_requests", "Maximum planned provider requests", plan.maximumProviderRequests, "report.historicalTransactions.evidence.queryPlan.maximumProviderRequests", String(plan.maximumProviderRequests), { unit: "requests", ...provenanceOptions }),
    directField("historical.max_returned_records", "Maximum planned returned records", plan.maximumReturnedRecords, "report.historicalTransactions.evidence.queryPlan.maximumReturnedRecords", String(plan.maximumReturnedRecords), { unit: "transfer records", ...provenanceOptions }),
    directField("historical.max_pages_per_authority", "Configured maximum pages per authority", plan.maxPagesPerAuthority, "report.historicalTransactions.evidence.queryPlan.maxPagesPerAuthority", String(plan.maxPagesPerAuthority), { unit: "pages", ...provenanceOptions }),
    directField("historical.max_records_per_authority", "Configured maximum records per authority", plan.maxRecordsPerAuthority, "report.historicalTransactions.evidence.queryPlan.maxRecordsPerAuthority", String(plan.maxRecordsPerAuthority), { unit: "transfer records", ...provenanceOptions }),
    directField("historical.enrichment_execution_completeness", "Transaction enrichment execution completeness", enrichment.evidence.executionCompleteness, "report.historicalTransactions.evidence.transactionEnrichment.evidence.executionCompleteness", enrichment.evidence.executionCompleteness, { ...provenanceOptions }),
    directField("historical.enrichment_selected_signature_count", "Selected transaction signature count", selection.selectedUniqueSignatureCount, "report.historicalTransactions.evidence.transactionSelection.selectedUniqueSignatureCount", String(selection.selectedUniqueSignatureCount), { unit: "signatures", ...provenanceOptions }),
    directField("historical.signature_cap", "Maximum selected transaction signatures", selection.signatureCap, "report.historicalTransactions.evidence.transactionSelection.signatureCap", String(selection.signatureCap), { unit: "signatures", ...provenanceOptions }),
    directField("historical.integration_candidate_count", "Integrated candidate count", integration.coverage.candidateSet.candidateCount, "report.historicalTransactions.evidence.transactionIntegration.coverage.candidateSet.candidateCount", String(integration.coverage.candidateSet.candidateCount), { unit: "candidates", ...provenanceOptions }),
    directField("historical.integration_eligible_count", "Eligible transaction candidates", integration.coverage.candidateSet.eligibleCount, "report.historicalTransactions.evidence.transactionIntegration.coverage.candidateSet.eligibleCount", String(integration.coverage.candidateSet.eligibleCount), { unit: "candidates", ...provenanceOptions }),
    directField("historical.integration_ineligible_count", "Ineligible transaction candidates", integration.coverage.candidateSet.ineligibleCount, "report.historicalTransactions.evidence.transactionIntegration.coverage.candidateSet.ineligibleCount", String(integration.coverage.candidateSet.ineligibleCount), { unit: "candidates", ...provenanceOptions }),
    directField("historical.integration_coverage_status", "Transaction integration coverage", integration.coverage.downstream.status, "report.historicalTransactions.evidence.transactionIntegration.coverage.downstream.status", integration.coverage.downstream.status, { ...provenanceOptions }),
  ];
  const metricsByAuthority = new Map(metrics.authorities.map((metric) => [metric.authorityAddress, metric]));
  const selectedAuthorityAddresses = new Set(plan.candidateAuthorities
    .filter((candidate) => candidate.plannedDisposition.status === "selected")
    .map((candidate) => candidate.authorityAddress));
  const authorities = evidence.authorities.flatMap((authority, index) =>
    selectedAuthorityAddresses.has(authority.authorityAddress)
    ? [presentAuthority(authority, index, plan, metricsByAuthority.get(authority.authorityAddress), evidence.provenance.provider, evidence.provenance.method, evidence.provenance.fetchedAt)]
      : []);
  const phase2A = enrichment.evidence.candidates;
  const integrationByCandidate = new Map(integration.candidates.map((candidate) => [candidate.candidateIndex, candidate]));
  const transactions: SolanaHistoricalTransactionPresentation[] = phase2A.map((candidate, candidateIndex) => {
    const integrated = integrationByCandidate.get(candidateIndex);
    const common = {
      candidateIndex,
      disposition: candidate.disposition.status as "selected" | "not_selected",
      selectionPosition: candidate.disposition.status === "selected" ? candidate.disposition.selectionPosition : null,
      acquisitionStatus: candidate.acquisition.status,
      requestProvenance: candidate.disposition.status === "selected" && "provenance" in candidate.acquisition
        ? { provider: candidate.acquisition.provenance.provider, method: candidate.acquisition.provenance.method, fetchedAt: candidate.acquisition.provenance.fetchedAt }
        : null,
      normalizationStatus: candidate.normalization.status,
      executionStatus: candidate.normalization.status === "available" ? candidate.normalization.transaction.execution.status : null,
      integrationStatus: integrated?.status ?? "not_available" as const,
    };
    if (!integrated || integrated.status === "not_eligible") {
      return { ...common, balanceFlowStatus: null, outerInstructionCoverage: null, innerInstructionCoverage: null, instructionProcessingCoverage: null, reconciliationCoverage: null, reconciliationReasonCodes: [] };
    }
    return {
      ...common,
      balanceFlowStatus: integrated.balanceFlow.status,
      outerInstructionCoverage: integrated.instructionEvidence.coverage.outer.status,
      innerInstructionCoverage: integrated.instructionEvidence.coverage.inner.status,
      instructionProcessingCoverage: integrated.instructionEvidence.coverage.processing,
      reconciliationCoverage: integrated.reconciliation.coverage.status,
      reconciliationReasonCodes: [...integrated.reconciliation.coverage.reasonCodes],
    };
  });
  const sourceWasBounded = sample.selectedAuthorityCount < sample.candidateAuthorityCount || sample.truncatedAuthorityCount > 0 || sample.providerErrorAuthorityCount > 0 || sample.unqueriedAuthorityCount > 0 || scope.candidateSetCompleteness !== "complete";
  return {
    id: "historical" as const,
    label: "Historical evidence",
    sourceStatus: sourceStatus(section),
    completeness: sourceWasBounded ? "partial" as const : "not_established" as const,
    limitations: [
      "This is bounded selected-authority evidence, not token-wide or lifetime history; complete pagination applies only to an individual requested authority and window.",
      "Page block-time bounds describe returned records only and do not establish chronological ordering or coverage of the requested interval.",
      "Instruction and balance-flow evidence is presented without buy, sell, swap, trade, or instruction-specific causal interpretation.",
      ...(sample.truncatedAuthorityCount > 0 ? ["One or more authority queries stopped at configured caps."] : []),
      ...(sample.providerErrorAuthorityCount > 0 ? ["One or more authority queries ended with provider errors."] : []),
      ...(integration.coverage.downstream.status === "conflicting" ? ["Transaction reference integration reports conflicting evidence."] : []),
    ],
    fields,
    requestedWindow: { ...evidence.provenance.requestedWindow },
    authorities,
    transactions,
  };
}

/** Projects an already assembled report into a fixed allowlisted presentation; it performs no acquisition. */
export function presentSolanaTokenEvidenceReport(
  report: SolanaTokenEvidenceReport,
): SolanaTokenEvidencePresentationV1 {
  return {
    schemaVersion: SOLANA_TOKEN_EVIDENCE_PRESENTATION_SCHEMA_VERSION,
    sourceReportSchemaVersion: report.schemaVersion,
    chain: "solana",
    token: {
      requestedMintAddress: report.assetAddress,
      name: null,
      symbol: null,
    },
    limitations: [CROSS_SECTION_TIMING_LIMITATION],
    sections: [
      identitySection(report),
      marketSection(report),
      holderSection(report),
      historicalSection(report),
    ],
  };
}
