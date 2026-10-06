import type { EvmChain } from "./evmToken";

/** A returned token balance at an address; this does not imply wallet or owner semantics. */
export interface EvmBalanceHolderObservation {
  address: string;
  rawBalance: string;
}

export type EvmHolderTerminalReason =
  | "natural_termination"
  | "page_cap"
  | "record_cap"
  | "page_and_record_caps"
  | "provider_error"
  | "malformed_response";

export type EvmHolderCoverage =
  /** Explicit provider pagination terminated; not blockchain-complete ownership. */
  | { status: "provider_complete" }
  | { status: "partial"; reason: "resource_limited" | "provider_error" | "malformed_response" }
  | { status: "unavailable"; reason: "provider_error" }
  | { status: "malformed"; reason: "malformed_response" };

export type EvmHolderProviderErrorCategory =
  | "configuration"
  | "transport"
  | "http"
  | "provider"
  | "malformed_response";

export interface EvmHolderFailureEvidence {
  category: EvmHolderProviderErrorCategory;
  httpStatus: number | null;
  message: string;
}

export interface EvmHolderPageEvidence {
  requestedPageNumber: number;
  providerRecordsReturned: number;
  recordsRetained: number;
  providerReportedPageSize: number;
  providerHasMore: boolean;
}

export interface EvmHolderPaginationEvidence {
  maxPages: number;
  /** Maximum number of provider rows normalized across the run; duplicates consume this budget. */
  maxRecords: number;
  requestedPageSize: 100;
  pagesRequested: number;
  pagesReturned: number;
  providerRecordsReturned: number | null;
  recordsRetained: number;
  providerReportedHolderCount: string | null;
  providerReportedPageSize: number | null;
  providerHasMore: boolean | null;
  terminalReason: EvmHolderTerminalReason;
  /** Validated pages accepted into normalized holder evidence, in request order. */
  pages: EvmHolderPageEvidence[];
}

export interface EvmHolderEvidenceProvenance {
  chain: EvmChain;
  provider: "goldrush";
  /** GoldRush routing identifier; not a TQE chain identity. */
  providerChainSlug: "base-mainnet" | "eth-mainnet";
  tokenContractAddress: string;
  requestedObservationBlock: string;
  providerReportedObservationBlock: string | null;
  providerBlockRelation: "match" | "mismatch" | "not_reported";
  fetchedAt: string;
}

export interface EvmHolderEvidence {
  schemaVersion: "evm-holder-evidence-v1";
  chain: EvmChain;
  tokenContractAddress: string;
  provenance: EvmHolderEvidenceProvenance;
  /** Returned balance-bearing addresses; zero balances are retained and exact duplicates collapse. */
  holders: EvmBalanceHolderObservation[];
  providerReportedHolderCount: string | null;
  observedHolderRecordCount: number;
  observedPositiveBalanceAddressCount: number;
  pagination: EvmHolderPaginationEvidence;
  coverage: EvmHolderCoverage;
  failure: EvmHolderFailureEvidence | null;
}

export interface EvmHolderEvidenceTelemetry {
  providerRequestCount: number;
  pagesRequested: number;
  pagesReturned: number;
  providerRecordsReturned: number | null;
  recordsRetained: number;
  elapsedMs: number;
}

export interface EvmHolderEvidenceExecutionResult {
  evidence: EvmHolderEvidence;
  telemetry: EvmHolderEvidenceTelemetry;
}
