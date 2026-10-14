import type { SolanaReferenceReconciliationReason } from "./solanaReferenceReconciliation";

export const SOLANA_TOKEN_EVIDENCE_PRESENTATION_SCHEMA_VERSION =
  "solana-token-evidence-presentation-v1" as const;

export type SolanaPresentationSectionId = "identity_mint" | "market" | "holders" | "historical";
export type SolanaPresentationCompleteness = "complete" | "partial" | "not_established";
export type SolanaPresentationValue = string | number | boolean | null;
export type SolanaPresentationValueStatus = "available" | "unavailable" | "unknown";
export type SolanaPresentationValueBasis =
  | "source_report"
  | "provider_reported"
  | "calculated"
  | "deterministic_summary";

export type SolanaPresentationSourceStatus =
  | { status: "present" }
  | { status: "unavailable"; reason: string; errorCategory?: string }
  | { status: "not_attempted"; reason: "mint_unresolved" | "holder_evidence_unavailable" }
  | { status: "not_requested" };

export interface SolanaPresentationProvenance {
  sourcePath: string;
  provider: string | null;
  method: string | null;
  /** Provider/application fetch time only when that exact source supplies it. */
  observedAt: string | null;
  sourceUpdatedAt: string | null;
  contextSlots: number[] | null;
  valueBasis: SolanaPresentationValueBasis;
}

export type SolanaPresentationFieldId =
  | "identity.requested_mint_address"
  | "identity.resolved_mint_address"
  | "identity.account_exists"
  | "identity.is_mint"
  | "identity.token_program"
  | "identity.decimals"
  | "identity.raw_supply"
  | "identity.mint_authority_status"
  | "identity.mint_authority_address"
  | "identity.freeze_authority_status"
  | "identity.freeze_authority_address"
  | "identity.extension_inventory_status"
  | "market.provider_fetch_time"
  | "market.source_updated_at"
  | "market.pool_count"
  | "market.primary_pool_address"
  | "market.token_created_at"
  | "market.token_age_seconds"
  | "market.lifecycle_state"
  | "market.lifecycle_basis"
  | "market.lifecycle_evidence"
  | "market.pool_created_at"
  | "market.price_usd"
  | "market.market_cap_usd"
  | "market.fdv_usd"
  | "market.liquidity_usd"
  | "market.volume_m5_usd"
  | "market.volume_h1_usd"
  | "market.volume_h6_usd"
  | "market.volume_h24_usd"
  | "holders.token_account_count"
  | "holders.nonzero_token_account_count"
  | "holders.positive_balance_owner_authority_count"
  | "holders.current_mint_supply_raw"
  | "holders.observed_positive_balance_raw"
  | "holders.supply_difference_raw"
  | "holders.enumeration_completeness"
  | "holders.amount_coverage_state"
  | "holders.amount_coverage_reason"
  | "holders.page_count"
  | "holders.minimum_balance_raw"
  | "holders.maximum_balance_raw"
  | "holders.median_balance_raw"
  | "holders.distinct_balance_count"
  | "holders.p25"
  | "holders.p50"
  | "holders.p75"
  | "holders.p90"
  | "holders.p99"
  | "holders.repeated_balance_group_count"
  | "holders.authorities_in_repeated_balance_groups"
  | "holders.authority_share_in_repeated_balance_groups"
  | "holders.concentration_top1_percentage"
  | "holders.concentration_top5_percentage"
  | "holders.concentration_top10_percentage"
  | "holders.concentration_top20_percentage"
  | "historical.window_start_inclusive"
  | "historical.window_end_exclusive"
  | "historical.provider_fetch_time"
  | "historical.candidate_authority_count"
  | "historical.candidate_set_completeness"
  | "historical.selected_authority_count"
  | "historical.queried_authority_count"
  | "historical.naturally_complete_authority_count"
  | "historical.truncated_authority_count"
  | "historical.provider_error_authority_count"
  | "historical.unqueried_authority_count"
  | "historical.max_authorities"
  | "historical.max_provider_requests"
  | "historical.max_returned_records"
  | "historical.max_pages_per_authority"
  | "historical.max_records_per_authority"
  | "historical.signature_cap"
  | "historical.enrichment_execution_completeness"
  | "historical.enrichment_selected_signature_count"
  | "historical.integration_candidate_count"
  | "historical.integration_eligible_count"
  | "historical.integration_ineligible_count"
  | "historical.integration_coverage_status";

export interface SolanaPresentationField {
  id: SolanaPresentationFieldId;
  label: string;
  /** Null values may be available only when the source explicitly establishes absence. */
  status: SolanaPresentationValueStatus;
  /** Exact source value when present; raw token quantities remain decimal strings. */
  value: SolanaPresentationValue;
  rawValue: SolanaPresentationValue;
  displayValue: string | null;
  unit: string | null;
  denominatorDescription: string | null;
  /** Available nulls can carry a reason such as `authority_unset`; unavailable/unknown values retain their cause here. */
  reason: string | null;
  sourceField: string | null;
  provenance: SolanaPresentationProvenance;
}

export interface SolanaTokenEvidencePresentationSectionBase {
  id: SolanaPresentationSectionId;
  label: string;
  sourceStatus: SolanaPresentationSourceStatus;
  completeness: SolanaPresentationCompleteness;
  limitations: string[];
  fields: SolanaPresentationField[];
}

export interface SolanaPresentationExtensionEntry {
  extensionTypeId: number;
  extensionName: string;
  payloadLength: number;
}

export interface SolanaIdentityPresentationSection extends SolanaTokenEvidencePresentationSectionBase {
  id: "identity_mint";
  extensionInventoryProvenance: SolanaPresentationProvenance;
  extensions: {
    status: "available" | "not_applicable" | "malformed" | "not_available";
    entries: SolanaPresentationExtensionEntry[];
    reason: string | null;
    limitation: string;
  };
}

export interface SolanaMarketPresentationPool {
  poolAddress: string;
  dexId: string;
  counterTokenAddress: string | null;
  provenance: SolanaPresentationProvenance;
  /** Metrics retain pool scope; the selected pool is identified at section level. */
  fields: SolanaPresentationField[];
}

export interface SolanaMarketPresentationSection extends SolanaTokenEvidencePresentationSectionBase {
  id: "market";
  pools: SolanaMarketPresentationPool[];
  primaryPoolAddress: string | null;
}

export interface SolanaPresentationConcentration {
  topN: 1 | 5 | 10 | 20;
  status: "available" | "unavailable";
  numeratorRaw: string | null;
  denominatorRaw: string;
  denominatorBasis: "current_mint_supply";
  denominatorDescription: "Current mint supply";
  percentage: string | null;
  unit: "percent";
  reason: string | null;
  provenance: SolanaPresentationProvenance;
}

export interface SolanaHolderCumulativeBalancePoint {
  ownerPercentile: 10 | 25 | 50 | 75 | 90 | 99 | 100;
  includedOwnerAuthorityCount: number;
  cumulativeObservedBalanceRaw: string;
  cumulativeObservedBalanceShare: string | null;
  cumulativeObservedBalanceShareUnit: "percent";
  cumulativeObservedBalanceShareDenominator: "observed_positive_owner_authority_balance";
}

export interface SolanaHolderRepeatedBalanceGroup {
  balanceRaw: string;
  ownerAuthorityCount: number;
}

export interface SolanaHolderPresentationSection extends SolanaTokenEvidencePresentationSectionBase {
  id: "holders";
  contextSlots: number[] | null;
  slotConsistency: "not_guaranteed" | null;
  unsupportedExtensionTypes: number[] | null;
  acquisition: {
    completeness: "complete" | "partial";
    stopReason: "provider_terminated" | "page_cap" | "request_timeout" | "provider_error" | "malformed_response";
    configuredMaxPages: 20;
    requestedPageSize: 5000;
  } | null;
  concentration: SolanaPresentationConcentration[] | null;
  balanceDistributionProvenance: SolanaPresentationProvenance | null;
  balanceDistribution: {
    observedOwnerAuthorityCount: number;
    observedPositiveOwnerAuthorityBalanceRaw: string;
    cumulativeOwnerBalanceProfile: SolanaHolderCumulativeBalancePoint[];
    distinctBalanceCount: number;
    repeatedBalanceGroups: SolanaHolderRepeatedBalanceGroup[];
    repeatedBalanceGroupsOmitted: number;
  } | null;
}

export interface SolanaHistoricalPagePresentation {
  pageNumber: number;
  requestLimit: number;
  recordCount: number;
  startRecordIndex: number;
  endRecordIndexExclusive: number;
  continuationTokenUsed: boolean;
  continuationTokenReturned: boolean;
  firstUsableBlockTime: number | null;
  lastUsableBlockTime: number | null;
  minimumUsableBlockTime: number | null;
  maximumUsableBlockTime: number | null;
  recordsWithoutUsableBlockTime: number;
}

export interface SolanaHistoricalAuthorityPresentation {
  authorityAddress: string;
  provenance: SolanaPresentationProvenance;
  selectionPosition: number | null;
  observedCandidateFrameRank: number | null;
  queryStatus: "success" | "provider_error" | "not_queried";
  paginationStatus: "complete" | "truncated" | "not_applicable";
  terminalReason: "natural_termination" | "page_cap" | "record_cap" | "page_and_record_caps" | "provider_error" | "not_queried";
  acceptedObservationCount: number;
  acceptedObservationCountBasis: "retained_observation_rows";
  pages: SolanaHistoricalPagePresentation[];
  observedBlockTimeBounds: { minimumUnixSeconds: number; maximumUnixSeconds: number; spanSeconds: number } | null;
  distinctSignatureCount: number | null;
  amountEvidence: {
    status: "available" | "unavailable";
    reason: string | null;
    queryCompleteness: "complete" | "partial" | null;
    exactRawAmountObservationCount: number | null;
    nonExactOrUnavailableAmountObservationCount: number | null;
    exactRawAmountCoverage: "complete" | "partial" | "none" | null;
    minimumExactRawAmount: string | null;
    maximumExactRawAmount: string | null;
  };
}

export interface SolanaHistoricalTransactionPresentation {
  candidateIndex: number;
  disposition: "selected" | "not_selected";
  selectionPosition: number | null;
  acquisitionStatus: "returned" | "provider_result_null" | "request_timeout" | "provider_error" | "malformed_response" | "not_attempted";
  requestProvenance: { provider: "helius"; method: "getTransaction"; fetchedAt: string } | null;
  normalizationStatus: "not_attempted" | "not_applicable" | "available" | "unsupported_transaction_version" | "malformed_structure" | "source_link_mismatch";
  executionStatus: "succeeded" | "failed" | "unavailable" | null;
  integrationStatus: "integrated" | "not_eligible" | "not_available";
  balanceFlowStatus: "complete" | "partial" | "unavailable" | "conflicting" | "not_applicable" | null;
  outerInstructionCoverage: "available" | "partial" | "unavailable" | null;
  innerInstructionCoverage: "available" | "partial" | "unavailable" | null;
  instructionProcessingCoverage: "complete_for_supplied_instruction_entries" | "partial" | null;
  reconciliationCoverage: "complete_for_supplied_evidence" | "partial" | "unavailable" | "conflicting" | null;
  reconciliationReasonCodes: SolanaReferenceReconciliationReason[];
}

export interface SolanaHistoricalPresentationSection extends SolanaTokenEvidencePresentationSectionBase {
  id: "historical";
  requestedWindow: {
    fromUnixSecondsInclusive: number;
    toUnixSecondsExclusive: number;
  } | null;
  authorities: SolanaHistoricalAuthorityPresentation[];
  transactions: SolanaHistoricalTransactionPresentation[];
}

export type SolanaTokenEvidencePresentationSection =
  | SolanaIdentityPresentationSection
  | SolanaMarketPresentationSection
  | SolanaHolderPresentationSection
  | SolanaHistoricalPresentationSection;

export interface SolanaTokenEvidencePresentationV1 {
  schemaVersion: typeof SOLANA_TOKEN_EVIDENCE_PRESENTATION_SCHEMA_VERSION;
  sourceReportSchemaVersion: "solana-token-evidence-report-v1";
  chain: "solana";
  token: {
    requestedMintAddress: string;
    name: null;
    symbol: null;
  };
  sections: [
    SolanaIdentityPresentationSection,
    SolanaMarketPresentationSection,
    SolanaHolderPresentationSection,
    SolanaHistoricalPresentationSection,
  ];
}

