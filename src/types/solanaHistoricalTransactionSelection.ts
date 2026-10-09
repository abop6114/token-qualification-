import type { SolanaHistoricalTimeWindow } from "./solanaHistoricalSampling";
import type { SolanaHistoricalQueryPlanVersioned } from "./solanaHistoricalQueryPlan";

export type SolanaHistoricalTransactionSourceRank =
  | { basis: "sourceRank"; value: number }
  | { basis: "observedCandidateFrameRank"; value: number };

export interface SolanaHistoricalTransactionSourceReference {
  sourceFingerprint: string;
  authorityAddress: string;
  authoritySelectionPosition: number;
  historicalObservationIndex: number;
  rank: SolanaHistoricalTransactionSourceRank;
}

export type SolanaHistoricalTransactionCandidateDisposition =
  | { status: "selected"; selectionPosition: number }
  | { status: "not_selected"; reason: "signature_cap" };

export interface SolanaHistoricalTransactionSignatureCandidate {
  signature: string;
  sourceObservations: SolanaHistoricalTransactionSourceReference[];
  disposition: SolanaHistoricalTransactionCandidateDisposition;
}

export interface SolanaHistoricalTransactionSelectionEvidence {
  schemaVersion: "solana-historical-transaction-selection-v1";
  chain: "solana";
  mintAddress: string;
  sourceHistoricalPlanVersion: SolanaHistoricalQueryPlanVersioned["planVersion"];
  sourceFingerprint: string;
  requestedWindow: SolanaHistoricalTimeWindow;
  sourceEvidenceFetchedAt: string;
  signatureCap: 5;
  /** Complete only relative to all valid signatures in the supplied source artifact. */
  selectionCompleteness: "complete";
  sourceCoverage: {
    holderCandidateFrameCompleteness: "complete" | "partial" | "unknown";
    candidateAuthorityCount: number;
    selectedAuthorityCount: number;
    naturallyCompleteAuthorityCount: number;
    truncatedAuthorityCount: number;
    providerErrorAuthorityCount: number;
    unqueriedAuthorityCount: number;
    signatureSourceCompleteness: "complete" | "partial";
  };
  uniqueSignatureCount: number;
  selectedUniqueSignatureCount: number;
  candidates: SolanaHistoricalTransactionSignatureCandidate[];
}
