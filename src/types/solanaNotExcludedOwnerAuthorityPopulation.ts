import type { SolanaHolderStructure } from "./holders";
import type { SolanaExclusionDecision } from "./solanaHolderExclusionAssessment";

export interface SolanaNotExcludedOwnerAuthorityPopulationEvidence {
  schemaVersion: "solana-not-excluded-owner-authority-population-v1";
  chain: "solana";
  mintAddress: string;
  policyVersion: "solana-address-exclusion-policy-v1";
  source: {
    holderSnapshotId: string;
    exclusionAssessmentSchemaVersion: "solana-holder-exclusion-assessment-v1";
    holderFetchedAt: string;
    enumeration: {
      completeness: "complete";
      slotConsistency: "not_guaranteed";
      pageCount: number;
      contextSlots: readonly number[];
    };
    amountCoverage: {
      state: "complete" | "partial";
      unsupportedExtensionTypes: readonly number[];
      reason: "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
    };
    currentMintSupplyRaw: string;
    supplyDifferenceRaw: string;
  };
  /** Positive owner authorities in canonical address order; these are not wallets or people. */
  subjects: Array<{
    subjectAddress: string;
    balanceRaw: string;
    decision: SolanaExclusionDecision;
  }>;
  raw: { subjectCount: number; observedPositiveBalanceRaw: string };
  byDecision: Record<SolanaExclusionDecision, { subjectCount: number; observedBalanceRaw: string }>;
  /** Retain and unresolved are both included; only explicit exclude is removed. */
  notExcluded: { subjectCount: number; observedBalanceRaw: string };
  reconciliation: {
    status: "reconciled";
    basis: "decision_categories_partition_observed_positive_owner_authority_rows";
  };
}
