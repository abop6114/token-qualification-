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
