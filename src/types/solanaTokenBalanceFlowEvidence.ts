import type { SolanaHistoricalTransactionSelectionEvidence } from "./solanaHistoricalTransactionSelection";
import type { SolanaTransactionRequestProvenance, SolanaTransactionEvidence } from "./solanaTransactionEvidence";

export type SolanaTokenBalanceFlowReason =
  | "transaction_failed"
  | "execution_state_unavailable"
  | "execution_state_conflicting"
  | "balance_side_unavailable"
  | "balance_side_conflicting"
  | "account_space_conflicting"
  | "invalid_pair_identity"
  | "duplicate_pair_key"
  | "account_index_multiple_mints"
  | "unmatched_pre"
  | "unmatched_post"
  | "amount_unavailable"
  | "amount_not_exact"
  | "amount_evidence_conflicting"
  | "decimals_unavailable"
  | "decimals_mismatch"
  | "decimals_evidence_conflicting"
  | "unresolved_account_address"
  | "account_address_mismatch";

export type SolanaTokenBalanceFlowStatus =
  | "complete"
  | "partial"
  | "unavailable"
  | "conflicting"
  | "not_applicable";

export type SolanaTokenBalanceFlowRawAmount =
  | { status: "available"; value: string; basis: "provider_integer_string" }
  | { status: "unavailable"; value: null; reason: "amount_unavailable" | "amount_not_exact" | "amount_evidence_conflicting" };

export type SolanaTokenBalanceFlowDelta =
  | { status: "available"; value: string; basis: "post_minus_pre_bigint" }
  | {
      status: "unavailable";
      value: null;
      reason: SolanaTokenBalanceFlowReason;
    };

export type SolanaTokenBalanceFlowField<T> =
  | { status: "available"; value: T }
  | {
      status: "unavailable";
      value: null;
      reason: "missing" | "null" | "malformed" | "unresolved_account";
    };

export interface SolanaTokenBalanceFlowPair {
  status: "matched" | "conflicting";
  accountIndex: number;
  mint: string;
  preProviderArrayIndex: number;
  postProviderArrayIndex: number;
  tokenAccountAddress: SolanaTokenBalanceFlowField<string>;
  preOwner: SolanaTokenBalanceFlowField<string>;
  postOwner: SolanaTokenBalanceFlowField<string>;
  preRawAmount: SolanaTokenBalanceFlowRawAmount;
  postRawAmount: SolanaTokenBalanceFlowRawAmount;
  preDecimals: SolanaTokenBalanceFlowField<number>;
  postDecimals: SolanaTokenBalanceFlowField<number>;
  decimals: { status: "available"; value: number } | { status: "unavailable"; value: null };
  rawDelta: SolanaTokenBalanceFlowDelta;
}

export interface SolanaTokenBalanceFlowUnmatchedObservation {
  side: "pre" | "post";
  providerArrayIndex: number;
  reason: "balance_side_unavailable" | "invalid_pair_identity" | "unmatched_pre" | "unmatched_post";
}

export interface SolanaTokenBalanceFlowConflict {
  reason:
    | "duplicate_pair_key"
    | "account_index_multiple_mints"
    | "account_address_mismatch"
    | "decimals_mismatch"
    | "amount_evidence_conflicting"
    | "decimals_evidence_conflicting"
    | "balance_side_conflicting";
  accountIndex: number;
  mint: string | null;
  preProviderArrayIndexes: number[];
  postProviderArrayIndexes: number[];
}

export interface SolanaTokenBalanceFlowPhase2ALinkage {
  sourceFingerprint: string;
  sourceHistoricalPlanVersion: SolanaHistoricalTransactionSelectionEvidence["sourceHistoricalPlanVersion"];
  requestedWindow: SolanaHistoricalTransactionSelectionEvidence["requestedWindow"];
  sourceEvidenceFetchedAt: string;
  signatureCap: 5;
  selectionPosition: number;
  sourceObservations: SolanaHistoricalTransactionSelectionEvidence["candidates"][number]["sourceObservations"];
  sourceCoverage: SolanaHistoricalTransactionSelectionEvidence["sourceCoverage"];
  transactionRequest: Pick<
    SolanaTransactionRequestProvenance,
    "chain" | "provider" | "method" | "encoding" | "commitment" | "maxSupportedTransactionVersion" | "requestedSignature" | "fetchedAt"
  >;
}

export interface SolanaTokenBalanceFlowPhase2AContext {
  selection: SolanaHistoricalTransactionSelectionEvidence;
  transactionRequest: SolanaTransactionRequestProvenance;
}

export interface SolanaTokenBalanceFlowEvidence {
  schemaVersion: "solana-token-balance-flow-evidence-v1";
  chain: "solana";
  transactionSignature: string;
  transactionExecution: SolanaTransactionEvidence["execution"];
  status: SolanaTokenBalanceFlowStatus;
  reasonCodes: SolanaTokenBalanceFlowReason[];
  /** One entry per unambiguous matching accountIndex + mint key. */
  pairs: SolanaTokenBalanceFlowPair[];
  unmatchedObservations: SolanaTokenBalanceFlowUnmatchedObservation[];
  conflicts: SolanaTokenBalanceFlowConflict[];
  /** Null means no validated Phase 2A linkage context was supplied. */
  phase2A: SolanaTokenBalanceFlowPhase2ALinkage | null;
}

