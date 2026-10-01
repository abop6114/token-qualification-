export interface SolanaHistoricalAuthoritySelectionEntry {
  authorityAddress: string;
  balanceRaw: string;
  /** Zero-based rank after balance-descending, address-ascending normalization. */
  sourceRank: number;
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
