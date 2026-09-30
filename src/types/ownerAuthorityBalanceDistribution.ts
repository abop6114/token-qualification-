export type EvidenceCoverageState = "complete" | "partial";

export interface OwnerAuthorityBalanceSnapshot {
  chain: string;
  assetAddress: string;
  snapshotAt: string;
  decimals: number;
  currentSupplyRaw: string;
  enumeration: {
    completeness: EvidenceCoverageState;
    slotConsistency: "atomic" | "not_guaranteed" | "unknown";
    pageCount: number;
    contextSlots: number[];
  };
  amountCoverage: {
    state: EvidenceCoverageState;
    unsupportedExtensionTypes: number[];
    reason: "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
  };
  rawOwnerCount: number;
  rawOwnerAuthorities: ReadonlyArray<{ balanceRaw: string }>;
}

export interface RepeatedBalanceFrequency {
  balanceRaw: string;
  ownerAuthorityCount: number;
}

export interface OwnerAuthorityBalanceDistribution {
  chain: string;
  assetAddress: string;
  population: "positive_owner_authorities";
  observedOwnerAuthorityCount: number;
  decimals: number;
  currentSupplyRaw: string;
  minimumBalanceRaw: string | null;
  maximumBalanceRaw: string | null;
  medianBalanceRaw: string | null;
  quantilesRaw: {
    /** Nearest-rank order statistics at p25, p50, p75, p90, and p99. */
    p25: string | null;
    p50: string | null;
    p75: string | null;
    p90: string | null;
    p99: string | null;
  };
  distinctBalanceCount: number;
  repeatedBalanceGroupCount: number;
  authoritiesInRepeatedBalanceGroups: number;
  /** Six-decimal percentage of observed authorities; null when the population is empty. */
  authorityShareInRepeatedBalanceGroups: string | null;
  /** Up to 25 repeated exact-balance groups, ranked by frequency then raw balance. */
  repeatedBalanceGroups: RepeatedBalanceFrequency[];
  repeatedBalanceGroupsOmitted: number;
  coverage: {
    /** Complete reflects source enumeration and amount coverage; slot atomicity is reported separately. */
    state: EvidenceCoverageState;
    source: "normalized_holder_snapshot";
    sourceSnapshotAt: string;
    enumerationCompleteness: EvidenceCoverageState;
    slotConsistency: "atomic" | "not_guaranteed" | "unknown";
    pageCount: number;
    contextSlots: number[];
    amountCoverageState: EvidenceCoverageState;
    amountCoverageReason: "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
    unsupportedExtensionTypes: number[];
  };
}
