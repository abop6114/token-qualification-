import type { SolanaHolderStructure } from "./holders";
import type { SolanaExclusionDecision } from "./solanaHolderExclusionAssessment";
import type { SolanaHolderSnapshotAcquisitionV2 } from "./solanaHolderSnapshot";
import type { SolanaHolderExclusionAssessmentV2 } from "./solanaHolderExclusionAssessment";

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

export interface SolanaNotExcludedOwnerAuthorityPopulationEvidenceV2 {
  schemaVersion: "solana-not-excluded-owner-authority-population-v2";
  chain: "solana";
  mintAddress: string;
  policyVersion: "solana-address-exclusion-policy-v1";
  frame: "observed_assessed_positive_owner_authorities";
  source: {
    holderSnapshotSchemaVersion: "solana-holder-snapshot-record-v2";
    holderSnapshotId: string;
    exclusionAssessmentSchemaVersion: SolanaHolderExclusionAssessmentV2["schemaVersion"];
    holderFetchedAt: string;
    acquisition: SolanaHolderSnapshotAcquisitionV2;
    enumeration: {
      completeness: "complete" | "partial";
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
    observedPositiveBalanceRaw: string;
    supplyDifferenceRaw: string;
  };
  subjects: SolanaNotExcludedOwnerAuthorityPopulationEvidence["subjects"];
  raw: SolanaNotExcludedOwnerAuthorityPopulationEvidence["raw"];
  byDecision: SolanaNotExcludedOwnerAuthorityPopulationEvidence["byDecision"];
  notExcluded: SolanaNotExcludedOwnerAuthorityPopulationEvidence["notExcluded"];
  reconciliation: SolanaNotExcludedOwnerAuthorityPopulationEvidence["reconciliation"];
}
