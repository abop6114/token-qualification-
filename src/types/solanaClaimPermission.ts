import type {
  SolanaQualificationMetricCompleteness,
  SolanaQualificationMetricId,
  SolanaQualificationMetricJsonValue,
  SolanaQualificationMetricSource,
  SolanaQualificationMetricStatus,
} from "./solanaQualificationMetricEvidence";
import type { SolanaTokenEvidenceReport } from "./solanaTokenEvidenceReport";

export const SOLANA_CLAIM_PERMISSION_SCHEMA_VERSION = "tqe-claim-permission-proposal-v1" as const;

export type SolanaClaimId =
  | "market.price_usd"
  | "market.liquidity_usd"
  | "market.market_cap_usd"
  | "market.fdv_usd"
  | "market.volume_m5_usd"
  | "market.volume_h1_usd"
  | "market.volume_h6_usd"
  | "market.volume_h24_usd"
  | "holders.token_account_count"
  | "holders.positive_token_account_count"
  | "holders.positive_owner_authority_count"
  | "holders.observed_frame_balance_distribution"
  | "holders.observed_positive_balance_raw"
  | "holders.full_population_count"
  | "holders.concentration_top1"
  | "holders.concentration_top5"
  | "holders.concentration_top10"
  | "holders.concentration_top20"
  | "token_controls.mint_authority_state"
  | "token_controls.freeze_authority_state"
  | "token_controls.token_program"
  | "token_controls.mint_extension_inventory"
  | "historical.sampled_activity"
  | "historical.transaction_integration_coverage"
  | "historical.momentum";

export type SolanaClaimScope =
  | "selected_pool"
  | "observed_token_account_rows"
  | "observed_positive_balance_accounts"
  | "observed_positive_owner_authorities"
  | "observed_frame"
  | "full_holder_population"
  | "raw_owner_authority_concentration"
  | "mint_base_authority_fields"
  | "mint_base_and_inventory_fields"
  | "selected_authorities_requested_window"
  | "selected_transaction_candidates"
  | "temporal_momentum";

export type SolanaClaimPermissionOutcome =
  | "permitted"
  | "withheld_insufficient"
  | "withheld_conflicting"
  | "not_evaluated_not_requested";

export type SolanaClaimPermissionReason =
  | "no_backing_metric"
  | "metric_unavailable"
  | "metric_not_eligible"
  | "conflicting_evidence"
  | "enumeration_incomplete"
  | "history_not_requested"
  | "history_not_sufficiently_bounded"
  | "unsupported_claim";

export type SolanaClaimLimitationCode =
  | "selected_pool_only"
  | "single_pool_observation"
  | "observed_frame_only"
  | "partial_enumeration"
  | "partial_amount_coverage"
  | "slot_consistency_not_guaranteed"
  | "owner_authorities_are_not_wallets_or_people"
  | "not_atomic_with_mint_supply"
  | "not_economic_control_concentration"
  | "base_fields_only"
  | "inventory_only"
  | "not_security_or_risk_assessment"
  | "bounded_selected_authorities_only"
  | "requested_window_is_not_observed_coverage"
  | "no_trade_or_direction_inference"
  | "no_momentum_metric_supported";

export interface SolanaClaimEvidenceReference {
  metricId: SolanaQualificationMetricId | null;
  fieldPath: string;
  status: SolanaQualificationMetricStatus | "report_field";
  value: SolanaQualificationMetricJsonValue;
  unit: string | null;
  completeness: SolanaQualificationMetricCompleteness;
  numeratorRaw: string | null;
  denominatorRaw: string | null;
  measurementBasis: string | null;
  evidenceKind: "provider_observation" | "deterministic_derivation" | null;
  limitation: string | null;
  reason: string | null;
  /** Safe acquisition/coverage facts retained from the normalized source report, when relevant. */
  sourceCoverage: SolanaQualificationMetricJsonValue | null;
  source: SolanaQualificationMetricSource;
}

interface SolanaClaimPermissionBase {
  id: SolanaClaimId;
  scope: SolanaClaimScope;
  /** Exact selected pool address for pool-scoped claims; null for other scopes or no selected pool. */
  scopeAddress: string | null;
  evidence: readonly SolanaClaimEvidenceReference[];
  limitationCodes: readonly SolanaClaimLimitationCode[];
}

export type SolanaClaimPermission =
  | (SolanaClaimPermissionBase & {
      outcome: "permitted";
      value: SolanaQualificationMetricJsonValue;
      unit: string | null;
      reason: null;
    })
  | (SolanaClaimPermissionBase & {
      outcome: "withheld_insufficient" | "withheld_conflicting";
      value: null;
      unit: string | null;
      reason: SolanaClaimPermissionReason;
    })
  | (SolanaClaimPermissionBase & {
      outcome: "not_evaluated_not_requested";
      value: null;
      unit: string | null;
      reason: "history_not_requested";
    });

export interface SolanaClaimPermissionEvidence {
  schemaVersion: typeof SOLANA_CLAIM_PERMISSION_SCHEMA_VERSION;
  chain: "solana";
  mintAddress: string;
  sourceReportSchemaVersion: SolanaTokenEvidenceReport["schemaVersion"];
  sourceReportGeneratedAt: string;
  claims: readonly SolanaClaimPermission[];
}
