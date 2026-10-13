import type {
  SolanaTokenBalanceFlowEvidence,
  SolanaTokenBalanceFlowPair,
} from "./solanaTokenBalanceFlowEvidence";
import type {
  SolanaSupportedTokenInstructionVariant,
  SolanaTokenInstructionDecodeResult,
  SolanaTokenInstructionLocation,
  SolanaTokenProgramInstructionEvidence,
} from "./solanaTokenProgramInstructionEvidence";

export const SOLANA_REFERENCE_RECONCILIATION_SCHEMA_VERSION =
  "solana-reference-reconciliation-v1" as const;

export type SolanaReferenceReconciliationIdentity =
  | { status: "matched"; signature: string }
  | {
      status: "conflicting";
      balanceFlowSignature: string;
      instructionSignature: string;
    };

export type SolanaReferenceExecutionState = "succeeded" | "failed" | "unavailable" | "contradictory";

export type SolanaReferenceExecutionComparison =
  | { status: "confirmed_compatible_success" }
  | { status: "confirmed_compatible_failure" }
  | {
      status: "one_or_both_unavailable";
      balanceFlow: SolanaReferenceExecutionState;
      instructionEvidence: SolanaReferenceExecutionState;
    }
  | {
      status: "contradictory_definitive_evidence";
      balanceFlow: "succeeded" | "failed";
      instructionEvidence: "succeeded" | "failed";
    }
  | {
      status: "malformed_or_contradictory_source_evidence";
      source: "balance_flow" | "instruction_evidence" | "both";
    }
  | { status: "not_comparable_identity_mismatch" };

export type SolanaReferenceMatchStatus =
  | "index_address_agreement"
  | "index_overlap_address_unverified"
  | "index_address_contradiction"
  | "instruction_reference_unresolved"
  | "no_pair_in_supplied_evidence"
  | "ambiguous_account_index"
  | "not_comparable";

export interface SolanaInstructionAccountReferenceRelationship {
  role: "source" | "destination";
  rolePosition: number;
  accountIndex: number;
  referenceStatus: "resolved" | "unresolved";
  address: string | null;
  matchStatus: SolanaReferenceMatchStatus;
  /** Indexes into the supplied Phase 2B `pairs` array, in source order. */
  candidatePairIndexes: number[];
}

export interface SolanaInstructionReferenceRelationship {
  /** Index into the supplied Phase 2C `instructions` array. */
  instructionSourceIndex: number;
  location: SolanaTokenInstructionLocation;
  decodeStatus: SolanaTokenInstructionDecodeResult["decodeStatus"];
  variant: SolanaSupportedTokenInstructionVariant | null;
  accountReferences: SolanaInstructionAccountReferenceRelationship[];
}

export type SolanaMintReferenceComparisonStatus =
  | "reported_mint_string_match"
  | "reported_mint_string_mismatch"
  | "no_pair_with_reported_mint_in_supplied_evidence"
  | "not_comparable";

export interface SolanaMintReferenceComparison {
  instructionSourceIndex: number;
  location: SolanaTokenInstructionLocation;
  rolePosition: number;
  accountIndex: number;
  referencedAddress: string;
  matchStatus: SolanaMintReferenceComparisonStatus;
  /** All Phase 2B pair indexes whose reported mint equals the reference. */
  candidatePairIndexes: number[];
}

export type SolanaReferenceReconciliationCoverageStatus =
  | "complete_for_supplied_evidence"
  | "partial"
  | "unavailable"
  | "conflicting";

export type SolanaReferenceReconciliationReason =
  | "transaction_identity_mismatch"
  | "execution_unavailable"
  | "execution_conflicting"
  | "balance_flow_partial"
  | "balance_flow_unavailable"
  | "balance_flow_conflicting"
  | "balance_flow_not_applicable"
  | "outer_instructions_partial"
  | "outer_instructions_unavailable"
  | "inner_instructions_partial"
  | "inner_instructions_unavailable"
  | "instruction_processing_partial"
  | "account_space_partial"
  | "account_space_conflicting"
  | "unresolved_instruction_reference"
  | "ambiguous_account_index"
  | "pair_reference_conflict"
  | "unsupported_or_malformed_instruction";

export interface SolanaReferenceReconciliationSourceCoverage {
  balanceFlowStatus: SolanaTokenBalanceFlowEvidence["status"];
  instructionOuter: SolanaTokenProgramInstructionEvidence["coverage"]["outer"];
  instructionInner: SolanaTokenProgramInstructionEvidence["coverage"]["inner"];
  instructionProcessing: SolanaTokenProgramInstructionEvidence["coverage"]["processing"];
  instructionAccountSpace: SolanaTokenProgramInstructionEvidence["coverage"]["accountSpace"];
}

export interface SolanaReferenceReconciliationCoverage {
  /** Complete applies only to processing the supplied eligible source records. */
  status: SolanaReferenceReconciliationCoverageStatus;
  reasonCodes: SolanaReferenceReconciliationReason[];
}

export interface SolanaReferenceReconciliationEvidence {
  schemaVersion: typeof SOLANA_REFERENCE_RECONCILIATION_SCHEMA_VERSION;
  chain: "solana";
  transactionIdentity: SolanaReferenceReconciliationIdentity;
  sourceSchemas: {
    balanceFlow: SolanaTokenBalanceFlowEvidence["schemaVersion"];
    instructionEvidence: SolanaTokenProgramInstructionEvidence["schemaVersion"];
  };
  executionComparison: SolanaReferenceExecutionComparison;
  instructionRelationships: SolanaInstructionReferenceRelationship[];
  mintReferenceComparisons: SolanaMintReferenceComparison[];
  sourceCoverage: SolanaReferenceReconciliationSourceCoverage;
  coverage: SolanaReferenceReconciliationCoverage;
}

/** Pair type alias used by consumers that need to resolve candidatePairIndexes. */
export type SolanaReferenceReconciliationPair = SolanaTokenBalanceFlowPair;
