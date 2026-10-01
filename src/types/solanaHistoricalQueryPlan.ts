import type { SolanaHistoricalAuthoritySelection } from "./solanaHistoricalAuthoritySelection";
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
