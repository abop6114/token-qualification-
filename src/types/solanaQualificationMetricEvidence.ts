import type { SolanaTokenEvidenceReport } from "./solanaTokenEvidenceReport";

export const SOLANA_QUALIFICATION_METRIC_EVIDENCE_SCHEMA_VERSION =
  "solana-qualification-metric-evidence-v1" as const;

export type SolanaQualificationMetricId =
  | "market.primary_pool.liquidity_usd"
  | "market.primary_pool.volume_h24_usd"
  | "market.primary_pool.price_usd"
  | "market.primary_pool.market_cap_usd"
  | "market.primary_pool.fdv_usd"
  | "holders.token_account_count"
  | "holders.nonzero_token_account_count"
  | "holders.positive_owner_authority_count"
  | "holders.observed_positive_balance_raw"
  | "holders.current_mint_supply_raw"
  | "holders.supply_difference_raw"
  | "holders.concentration_top1"
  | "holders.concentration_top5"
  | "holders.concentration_top10"
  | "holders.concentration_top20"
  | "holders.distribution.minimum_balance_raw"
  | "holders.distribution.maximum_balance_raw"
  | "holders.distribution.median_balance_raw"
  | "holders.distribution.quantile_p25_raw"
  | "holders.distribution.quantile_p50_raw"
  | "holders.distribution.quantile_p75_raw"
  | "holders.distribution.quantile_p90_raw"
  | "holders.distribution.quantile_p99_raw"
  | "holders.distribution.distinct_balance_count"
  | "holders.distribution.repeated_balance_group_count"
  | "holders.distribution.authorities_in_repeated_balance_groups"
  | "holders.distribution.authority_share_in_repeated_balance_groups"
  | "holders.distribution.cumulative_profile"
  | "holders.distribution.repeated_balance_groups"
  | "token_controls.token_program"
  | "token_controls.mint_authority_state"
  | "token_controls.mint_authority_address"
  | "token_controls.freeze_authority_state"
  | "token_controls.freeze_authority_address"
  | "token_controls.mint_extension_inventory"
  | "historical.request_state"
  | "historical.requested_window"
  | "historical.sample_coverage"
  | "historical.authority.accepted_observation_count"
  | "historical.authority.distinct_signature_count"
  | "historical.authority.observed_block_time_bounds"
  | "historical.authority.missing_block_time_count"
  | "historical.authority.transfer_type_counts"
  | "historical.authority.endpoint_relationship_counts"
  | "historical.authority.amount_evidence_profile"
  | "historical.transaction_integration_coverage";

export type SolanaQualificationMetricStatus =
  | "available"
  | "unavailable"
  | "not_attempted"
  | "not_requested"
  | "not_applicable"
  | "unknown"
  | "conflicting"
  | "malformed";

export type SolanaQualificationMetricCompleteness =
  | "complete"
  | "partial"
  | "not_established"
  | null;

export type SolanaQualificationMetricJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly SolanaQualificationMetricJsonValue[]
  | { readonly [key: string]: SolanaQualificationMetricJsonValue };

/** Identifies the normalized report field and only the provenance it actually records. */
export interface SolanaQualificationMetricSource {
  section: "mint" | "market" | "holders" | "historicalTransactions";
  fieldPath: string;
  provider: string | null;
  method: string | null;
  /** Null unless the report contains an observation time for this source. */
  observedAt: string | null;
  sourceUpdatedAt: string | null;
  contextSlots: readonly number[] | null;
}

/**
 * A descriptive projection of one existing measurement, not a qualification result or score.
 * Raw token quantities remain decimal strings; unavailable values are null, never zero.
 */
export interface SolanaQualificationMetricEvidenceEntry {
  id: SolanaQualificationMetricId;
  label: string;
  status: SolanaQualificationMetricStatus;
  value: SolanaQualificationMetricJsonValue;
  unit: string | null;
  /** Existing exact raw numerator/denominator where applicable; never coerced through Number. */
  numeratorRaw: string | null;
  denominatorRaw: string | null;
  measurementBasis: string | null;
  evidenceKind: "provider_observation" | "deterministic_derivation";
  /** Describes this entry's source evidence only; null means no completeness claim is established. */
  completeness: SolanaQualificationMetricCompleteness;
  reason: string | null;
  limitation: string | null;
  source: SolanaQualificationMetricSource;
  /** Identifies a selected pool or queried authority; repeated IDs are distinguished by scope. */
  scope: { kind: "selected_pool"; address: string } | { kind: "authority"; address: string } | null;
}

export interface SolanaQualificationMetricEvidence {
  schemaVersion: typeof SOLANA_QUALIFICATION_METRIC_EVIDENCE_SCHEMA_VERSION;
  chain: "solana";
  mintAddress: string;
  sourceReportSchemaVersion: SolanaTokenEvidenceReport["schemaVersion"];
  sourceReportGeneratedAt: string;
  entries: SolanaQualificationMetricEvidenceEntry[];
}

export type SolanaQualificationMetricEvidenceInputErrorReason = "malformed_report" | "identity_mismatch";
