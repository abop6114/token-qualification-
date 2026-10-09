import type { SolanaHolderSnapshotRecordV2 } from "./solanaHolderSnapshot";

export interface SolanaHistoricalAuthoritySelectionEntry {
  authorityAddress: string;
  balanceRaw: string;
  /** Zero-based rank after balance-descending, address-ascending normalization. */
  sourceRank: number;
  /** Zero-based position in the selected authorities list. */
  selectionPosition: number;
  selectionReason: "rank_position";
}

export interface SolanaHistoricalAuthoritySelectionEntryV2 {
  authorityAddress: string;
  balanceRaw: string;
  /** Zero-based rank within this observed candidate frame; never a global token-holder rank. */
  observedCandidateFrameRank: number;
  /** Zero-based position in the selected authorities list. */
  selectionPosition: number;
  selectionReason: "rank_position";
}

export interface SolanaHistoricalAuthoritySelection {
  selectorVersion: "solana-rank-coverage-v1";
  selectionBasis: "balance_descending_evenly_spaced_ranks_nearest_half_up";
  mintAddress: string;
  sourceHolderSnapshotFetchedAt: string;
  candidateAuthorityCount: number;
  selectedAuthorityCount: number;
  configuredMaximumSelectedAuthorityCount: number;
  sourceCoverage: {
    enumeration: {
      completeness: "complete";
      slotConsistency: "not_guaranteed";
      pageCount: number;
      contextSlots: number[];
    };
    amountCoverage: {
      state: "complete" | "partial";
      reason: "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
      unsupportedExtensionTypes: number[];
    };
  };
  selectedAuthorities: SolanaHistoricalAuthoritySelectionEntry[];
}

export interface SolanaHistoricalAuthoritySelectionV2 {
  selectorVersion: "solana-rank-coverage-v2";
  selectionBasis: "balance_descending_evenly_spaced_ranks_nearest_half_up";
  mintAddress: string;
  sourceHolderSnapshotSchemaVersion: SolanaHolderSnapshotRecordV2["schemaVersion"];
  sourceHolderSnapshotId: string;
  sourceHolder: {
    source: SolanaHolderSnapshotRecordV2["source"];
    mintAddress: string;
    fetchedAt: string;
    acquisition: SolanaHolderSnapshotRecordV2["acquisition"];
    candidateFrameCompleteness: "complete" | "partial";
    candidateAuthorityCount: number;
    enumeration: {
      completeness: "complete" | "partial";
      slotConsistency: "not_guaranteed";
      pageCount: number;
      contextSlots: number[];
    };
    amountCoverage: {
      state: "complete" | "partial";
      reason: "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
      unsupportedExtensionTypes: number[];
    };
  };
  selectedAuthorityCount: number;
  configuredMaximumSelectedAuthorityCount: number;
  selectedAuthorities: SolanaHistoricalAuthoritySelectionEntryV2[];
}

export type SolanaHistoricalAuthoritySelectionVersioned =
  | SolanaHistoricalAuthoritySelection
  | SolanaHistoricalAuthoritySelectionV2;
