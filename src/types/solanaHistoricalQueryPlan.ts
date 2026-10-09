import type { SolanaHistoricalAuthoritySelection, SolanaHistoricalAuthoritySelectionV2 } from "./solanaHistoricalAuthoritySelection";
import type { SolanaHolderSnapshotRecordV2 } from "./solanaHolderSnapshot";
import type { SolanaHistoricalTimeWindow } from "./solanaHistoricalSampling";

export type SolanaHistoricalPlannedCandidate = {
  authorityAddress: string;
  balanceRaw: string;
  sourceRank: number;
} & (
  | {
      plannedDisposition: {
        status: "selected";
        selectionPosition: number;
        selectionReason: SolanaHistoricalAuthoritySelection["selectedAuthorities"][number]["selectionReason"];
      };
    }
  | {
      plannedDisposition: { status: "not_selected" };
    }
);

export interface SolanaHistoricalQueryPlan {
  planVersion: "solana-bounded-history-query-plan-v1";
  mintAddress: string;
  requestedWindow: SolanaHistoricalTimeWindow;
  maxPagesPerAuthority: number;
  maxRecordsPerAuthority: number;
  selectedAuthorityCount: number;
  maximumProviderRequests: number;
  maximumReturnedRecords: number;
  sourceSelection: {
    selectorVersion: SolanaHistoricalAuthoritySelection["selectorVersion"];
    selectionBasis: SolanaHistoricalAuthoritySelection["selectionBasis"];
    configuredMaximumSelectedAuthorityCount: number;
    selectedAuthorityCount: number;
  };
  sourceHolder: {
    fetchedAt: string;
    candidateAuthorityCount: number;
    enumeration: SolanaHistoricalAuthoritySelection["sourceCoverage"]["enumeration"];
    amountCoverage: SolanaHistoricalAuthoritySelection["sourceCoverage"]["amountCoverage"];
  };
  /** The complete observed candidate frame, in normalized rank order. */
  candidateAuthorities: SolanaHistoricalPlannedCandidate[];
}

export type SolanaHistoricalPlannedCandidateV2 = {
  authorityAddress: string;
  balanceRaw: string;
  /** Zero-based rank within the observed candidate frame; never a global token-holder rank. */
  observedCandidateFrameRank: number;
} & (
  | {
      plannedDisposition: {
        status: "selected";
        selectionPosition: number;
        selectionReason: SolanaHistoricalAuthoritySelectionV2["selectedAuthorities"][number]["selectionReason"];
      };
    }
  | { plannedDisposition: { status: "not_selected" } }
);

export interface SolanaHistoricalQueryPlanV2 {
  planVersion: "solana-bounded-history-query-plan-v2";
  mintAddress: string;
  requestedWindow: SolanaHistoricalTimeWindow;
  maxPagesPerAuthority: number;
  maxRecordsPerAuthority: number;
  selectedAuthorityCount: number;
  maximumProviderRequests: number;
  maximumReturnedRecords: number;
  sourceSelection: {
    selectorVersion: SolanaHistoricalAuthoritySelectionV2["selectorVersion"];
    selectionBasis: SolanaHistoricalAuthoritySelectionV2["selectionBasis"];
    configuredMaximumSelectedAuthorityCount: number;
    selectedAuthorityCount: number;
  };
  sourceHolder: {
    snapshotSchemaVersion: SolanaHolderSnapshotRecordV2["schemaVersion"];
    snapshotId: string;
    source: SolanaHolderSnapshotRecordV2["source"];
    mintAddress: string;
    fetchedAt: string;
    acquisition: SolanaHolderSnapshotRecordV2["acquisition"];
    candidateAuthorityCount: number;
    candidateFrameCompleteness: "complete" | "partial";
    enumeration: SolanaHistoricalAuthoritySelectionV2["sourceHolder"]["enumeration"];
    amountCoverage: SolanaHistoricalAuthoritySelectionV2["sourceHolder"]["amountCoverage"];
  };
  candidateAuthorities: SolanaHistoricalPlannedCandidateV2[];
}

export type SolanaHistoricalQueryPlanVersioned = SolanaHistoricalQueryPlan | SolanaHistoricalQueryPlanV2;
