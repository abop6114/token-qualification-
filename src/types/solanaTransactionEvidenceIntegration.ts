import type { SolanaBoundedHistoricalSamplingEvidence } from "./solanaHistoricalSampling";
import type { SolanaHistoricalQueryPlanVersioned } from "./solanaHistoricalQueryPlan";
import type { SolanaTransactionEnrichmentExecutionResult } from "./solanaTransactionEnrichment";
import type { SolanaReferenceReconciliationEvidence } from "./solanaReferenceReconciliation";
import type { SolanaTokenBalanceFlowEvidence } from "./solanaTokenBalanceFlowEvidence";
import type { SolanaTokenProgramInstructionEvidence } from "./solanaTokenProgramInstructionEvidence";

export const SOLANA_TRANSACTION_EVIDENCE_INTEGRATION_SCHEMA_VERSION =
  "solana-transaction-evidence-integration-v1" as const;

export interface IntegrateSolanaTransactionEvidenceInput {
  /** Previously acquired Phase 2A result; this function never performs acquisition. */
  phase2A: SolanaTransactionEnrichmentExecutionResult;
  /** Revalidation inputs used to verify the selection and its configured source bounds. */
  plan: SolanaHistoricalQueryPlanVersioned;
  historicalEvidence: SolanaBoundedHistoricalSamplingEvidence;
}

export type SolanaTransactionEvidenceIntegrationCandidate =
  | {
      /** Index into phase2A.evidence.candidates. */
      candidateIndex: number;
      signature: string;
      status: "not_eligible";
    }
  | {
      /** Index into phase2A.evidence.candidates. */
      candidateIndex: number;
      signature: string;
      status: "integrated";
      balanceFlow: SolanaTokenBalanceFlowEvidence;
      instructionEvidence: SolanaTokenProgramInstructionEvidence;
      reconciliation: SolanaReferenceReconciliationEvidence;
    };

export interface SolanaTransactionEvidenceIntegrationCoverage {
  candidateSet: {
    status: "no_candidates" | "none_eligible" | "some_eligible" | "all_eligible";
    candidateCount: number;
    eligibleCount: number;
    ineligibleCount: number;
  };
  downstream: {
    status:
      | "not_applicable"
      | "complete_for_integrated_candidates"
      | "partial"
      | "unavailable"
      | "conflicting";
    completeCount: number;
    partialCount: number;
    unavailableCount: number;
    conflictingCount: number;
  };
}

export interface SolanaTransactionEvidenceIntegrationEvidence {
  schemaVersion: typeof SOLANA_TRANSACTION_EVIDENCE_INTEGRATION_SCHEMA_VERSION;
  chain: "solana";
  /** Retained unchanged; integration candidate indexes address this source array. */
  phase2A: SolanaTransactionEnrichmentExecutionResult;
  /** Preserves the Phase 2A candidate order exactly. */
  candidates: SolanaTransactionEvidenceIntegrationCandidate[];
  coverage: SolanaTransactionEvidenceIntegrationCoverage;
}

export type SolanaTransactionEvidenceIntegrationInputErrorReason =
  | "malformed_input"
  | "selection_mismatch"
  | "candidate_mismatch"
  | "telemetry_mismatch";

