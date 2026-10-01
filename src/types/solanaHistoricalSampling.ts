import type { HeliusTransferObservation } from "../providers/solana/heliusTransfersByAddress";

export type SolanaCandidateAuthoritySource = "explicit_list" | "holder_snapshot";
export type SolanaCandidateSetCompleteness = "complete" | "partial" | "unknown";

export type SolanaHistoricalPaginationStatus = "complete" | "truncated" | "not_applicable";
export type SolanaHistoricalTerminalReason =
  | "natural_termination"
  | "page_cap"
  | "record_cap"
  | "page_and_record_caps"
  | "provider_error"
  | "not_queried";

export interface SolanaHistoricalTimeWindow {
  /** Inclusive lower bound for provider-reported transfer time, in Unix seconds. */
  fromUnixSecondsInclusive: number;
  /** Exclusive upper bound for provider-reported transfer time, in Unix seconds. */
  toUnixSecondsExclusive: number;
}

export interface SolanaHistoricalQueryProvenance {
  provider: string;
  method: string;
  /** Application fetch time in ISO 8601 form. */
  fetchedAt: string;
  requestedWindow: SolanaHistoricalTimeWindow;
  maxAuthorities: number;
  maxPagesPerAuthority: number;
  maxRecordsPerAuthority: number;
}

export interface SolanaHistoricalAuthorityScope {
  source: SolanaCandidateAuthoritySource;
  /** Null means the size of the candidate frame was not established. */
  candidateAuthorityCount: number | null;
  candidateSetCompleteness: SolanaCandidateSetCompleteness;
}

export interface SolanaHistoricalPageEvidence {
  pageNumber: number;
  requestLimit: number;
  recordCount: number;
  /** Zero-based inclusive index into this authority's combined observations. */
  startRecordIndex: number;
  /** Zero-based exclusive index into this authority's combined observations. */
  endRecordIndexExclusive: number;
  continuationTokenUsed: boolean;
  continuationTokenReturned: boolean;
  /** First non-null usable provider blockTime in response order; never sorted. */
  firstUsableBlockTime: number | null;
  /** Last non-null usable provider blockTime in response order; never sorted. */
  lastUsableBlockTime: number | null;
  minimumUsableBlockTime: number | null;
  maximumUsableBlockTime: number | null;
  recordsWithoutUsableBlockTime: number;
}

export type SolanaHistoricalObservedTime =
  | { status: "available"; unixSeconds: number; basis: "provider_reported" }
  | { status: "unavailable"; value: null; reason: "missing" | "null" };

type HeliusReportedAmountFields = Pick<
  HeliusTransferObservation["amount"],
  "reportedAmount" | "reportedAmountType" | "reportedUiAmount" | "reportedUiAmountType"
>;

export type SolanaHistoricalAmountEvidence =
  | (HeliusReportedAmountFields & {
      rawAmount: string;
      exactRawAvailable: true;
      exactnessBasis: "provider_integer_string";
      unavailableReason: null;
      reportedAmount: string;
      reportedAmountType: "integer_string";
    })
  | (HeliusReportedAmountFields & {
      rawAmount: null;
      exactRawAvailable: false;
      exactnessBasis: null;
      unavailableReason: "not_reported" | "provider_representation_not_exact";
      reportedAmountType: Exclude<HeliusTransferObservation["amount"]["reportedAmountType"], "integer_string">;
    });

/**
 * Retains the Helius observation fields while making its amount the single
 * authoritative, precision-safe amount representation in this contract.
 */
export type SolanaHistoricalProviderRecord = Omit<HeliusTransferObservation, "amount"> & {
  amount: SolanaHistoricalAmountEvidence;
};

export interface SolanaHistoricalTransferObservation {
  /** The Helius observation, with its amount represented exactly once. */
  providerRecord: SolanaHistoricalProviderRecord;
  /** Explicit availability projection of providerRecord.blockTime. */
  observedTime: SolanaHistoricalObservedTime;
}

export interface SolanaHistoricalProviderError {
  category: string;
  /** Sanitized diagnostic only; never a raw response, authenticated URL, or credential. */
  message: string;
}

interface SolanaHistoricalAuthorityResultBase {
  authorityAddress: string;
  requestCount: number;
  pages: SolanaHistoricalPageEvidence[];
  observations: SolanaHistoricalTransferObservation[];
}

export type SolanaHistoricalAuthorityEvidence =
  | (SolanaHistoricalAuthorityResultBase & {
      queryStatus: "success";
      paginationStatus: "complete";
      terminalReason: "natural_termination";
      providerError: null;
    })
  | (SolanaHistoricalAuthorityResultBase & {
      queryStatus: "success";
      paginationStatus: "truncated";
      terminalReason: "page_cap" | "record_cap" | "page_and_record_caps";
      providerError: null;
    })
  | (SolanaHistoricalAuthorityResultBase & {
      queryStatus: "provider_error";
      paginationStatus: "not_applicable";
      terminalReason: "provider_error";
      providerError: SolanaHistoricalProviderError;
    })
  | {
      authorityAddress: string;
      queryStatus: "not_queried";
      reason: "not_selected" | "budget_limit";
      paginationStatus: "not_applicable";
      terminalReason: "not_queried";
      requestCount: 0;
      pages: [];
      observations: [];
      providerError: null;
    };

export interface SolanaBoundedHistoricalSamplingEvidence {
  chain: "solana";
  mintAddress: string;
  provenance: SolanaHistoricalQueryProvenance;
  authorityScope: SolanaHistoricalAuthorityScope;
  /** Includes all authorities in the declared candidate frame, including those not queried. */
  authorities: SolanaHistoricalAuthorityEvidence[];
  /** No transfer-count, rate, volume, or other application metric is calculated in this contract. */
  applicationDerivedEvidence: {
    status: "not_calculated";
    metrics: null;
  };
}
