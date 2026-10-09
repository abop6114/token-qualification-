import type {
  SolanaTransactionEvidence,
  SolanaTransactionRequestProvenance,
} from "./solanaTransactionEvidence";
import type { SolanaHistoricalTransactionSelectionEvidence } from "./solanaHistoricalTransactionSelection";

export type SolanaTransactionEnrichmentAcquisition =
  | { status: "returned"; provenance: SolanaTransactionRequestProvenance }
  | { status: "provider_result_null"; provenance: SolanaTransactionRequestProvenance }
  | {
      status: "request_timeout";
      provenance: SolanaTransactionRequestProvenance;
      error: { category: "request_timeout"; message: string };
    }
  | {
      status: "provider_error";
      provenance: SolanaTransactionRequestProvenance;
      error: { category: "configuration" | "transport" | "http" | "rpc"; httpStatus: number | null; rpcCode: number | null; message: string };
    }
  | {
      status: "malformed_response";
      provenance: SolanaTransactionRequestProvenance;
      message: string;
    };

export type SolanaTransactionEnrichmentNormalization =
  | { status: "not_attempted" }
  | { status: "not_applicable" }
  | { status: "available"; transaction: SolanaTransactionEvidence }
  | { status: "unsupported_transaction_version" }
  | { status: "malformed_structure" }
  | { status: "source_link_mismatch" };

export type SolanaTransactionEnrichmentCandidateResult =
  | {
      signature: string;
      sourceObservations: SolanaHistoricalTransactionSelectionEvidence["candidates"][number]["sourceObservations"];
      disposition: { status: "not_selected"; reason: "signature_cap" };
      acquisition: { status: "not_attempted" };
      normalization: { status: "not_attempted" };
    }
  | {
      signature: string;
      sourceObservations: SolanaHistoricalTransactionSelectionEvidence["candidates"][number]["sourceObservations"];
      disposition: { status: "selected"; selectionPosition: number };
      acquisition: SolanaTransactionEnrichmentAcquisition;
      normalization: SolanaTransactionEnrichmentNormalization;
    };

export interface SolanaBoundedTransactionEnrichmentEvidence {
  schemaVersion: "solana-bounded-transaction-enrichment-v1";
  chain: "solana";
  mintAddress: string;
  sourceFingerprint: string;
  /** Complete means each unique signature in this supplied selection received an outcome, not that history is complete. */
  selectionCompleteness: "complete";
  /** Complete means every selected request had a determinate acquisition/content outcome; null is a determinate provider result. */
  executionCompleteness: "complete" | "partial" | "not_applicable";
  candidates: SolanaTransactionEnrichmentCandidateResult[];
}

export interface SolanaTransactionEnrichmentTelemetry {
  selectedUniqueSignatureCount: number;
  attemptedSignatureCount: number;
  returnedTransactionCount: number;
  providerNullCount: number;
  providerErrorCount: number;
  requestTimeoutCount: number;
  malformedResponseCount: number;
  normalizedTransactionCount: number;
  partialStructuralTransactionCount: number;
  requestCount: number;
  /** Wall-clock duration for this execution only; not part of source evidence or its fingerprint. */
  elapsedMs: number;
}

export interface SolanaTransactionEnrichmentExecutionResult {
  selection: SolanaHistoricalTransactionSelectionEvidence;
  evidence: SolanaBoundedTransactionEnrichmentEvidence;
  telemetry: SolanaTransactionEnrichmentTelemetry;
}
