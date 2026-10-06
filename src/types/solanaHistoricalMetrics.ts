import type { SolanaHistoricalTimeWindow } from "./solanaHistoricalSampling";

export type SolanaHistoricalMetricCompleteness = "complete" | "partial";

export type SolanaHistoricalMetricValue<T> =
  | {
      status: "available";
      value: T;
      queryCompleteness: SolanaHistoricalMetricCompleteness;
    }
  | {
      status: "unavailable";
      value: null;
      reason: "not_queried" | "provider_error" | "no_usable_block_times";
    };

export interface SolanaHistoricalEndpointRelationshipCounts {
  reportedInbound: number;
  reportedOutbound: number;
  reportedSelfDirected: number;
  ambiguous: number;
}

export interface SolanaHistoricalTransferTypeCount {
  availability: "reported" | "null" | "missing";
  /** Null when the provider returned null or omitted type. */
  reportedType: string | null;
  count: number;
}

export type SolanaHistoricalReportedAmountType =
  | "integer_string"
  | "non_integer_string"
  | "safe_integer_number"
  | "non_integer_number"
  | "unsafe_integer_number"
  | "null"
  | "missing";

export interface SolanaHistoricalReportedAmountTypeCount {
  reportedAmountType: SolanaHistoricalReportedAmountType;
  count: number;
}

export interface SolanaHistoricalAmountEvidenceProfile {
  exactRawAmountObservationCount: number;
  nonExactOrUnavailableAmountObservationCount: number;
  /** Includes every reportedAmountType in fixed discriminator order. */
  reportedAmountTypeCounts: SolanaHistoricalReportedAmountTypeCount[];
  /** Coverage of exact raw representation among retained observation rows only. */
  exactRawAmountCoverage: "complete" | "partial" | "none";
  minimumExactRawAmount: string | null;
  maximumExactRawAmount: string | null;
}

export interface SolanaHistoricalAuthorityMetrics {
  authorityAddress: string;
  queryStatus: "success" | "provider_error" | "not_queried";
  paginationStatus: "complete" | "truncated" | "not_applicable";
  acceptedObservationCount: SolanaHistoricalMetricValue<number>;
  usableBlockTimeCount: SolanaHistoricalMetricValue<number>;
  missingBlockTimeCount: SolanaHistoricalMetricValue<number>;
  observedBlockTimeBounds: SolanaHistoricalMetricValue<{
    minimumUnixSeconds: number;
    maximumUnixSeconds: number;
    spanSeconds: number;
  }>;
  distinctSignatureCount: SolanaHistoricalMetricValue<number>;
  reportedTransferTypeCounts: SolanaHistoricalMetricValue<SolanaHistoricalTransferTypeCount[]>;
  reportedEndpointRelationshipCounts: SolanaHistoricalMetricValue<SolanaHistoricalEndpointRelationshipCounts>;
  amountEvidenceProfile: SolanaHistoricalMetricValue<SolanaHistoricalAmountEvidenceProfile>;
}

export interface SolanaHistoricalSampleCoverage {
  candidateAuthorityCount: number;
  selectedAuthorityCount: number;
  queriedAuthorityCount: number;
  naturallyCompleteAuthorityCount: number;
  truncatedAuthorityCount: number;
  providerErrorAuthorityCount: number;
  unqueriedAuthorityCount: number;
}

export interface SolanaHistoricalDescriptiveMetrics {
  version: "solana-historical-descriptive-metrics-v1";
  source: {
    mintAddress: string;
    requestedWindow: SolanaHistoricalTimeWindow;
    evidenceFetchedAt: string;
    selectorVersion: string;
    selectionBasis: string;
    candidateAuthorityCount: number;
    candidateSetCompleteness: "complete" | "partial" | "unknown";
    selectedAuthorityCount: number;
  };
  sampleCoverage: SolanaHistoricalSampleCoverage;
  authorities: SolanaHistoricalAuthorityMetrics[];
}
