import type { SolanaHolderStructure } from "./holders";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type SolanaHolderSnapshotPayload = DeepReadonly<SolanaHolderStructure>;

export interface SolanaHolderSnapshotSource {
  readonly provider: "helius";
  readonly method: "getProgramAccountsV2";
  readonly commitment: "finalized";
}

export interface SolanaHolderSnapshotRecord {
  readonly schemaVersion: "solana-holder-snapshot-record-v1";
  readonly snapshotId: string;
  readonly source: SolanaHolderSnapshotSource;
  readonly snapshot: SolanaHolderSnapshotPayload;
}

export type SolanaSnapshotMetric<T> =
  | { status: "available"; value: T; completeness: "complete" | "partial" }
  | {
      status: "unavailable";
      value: null;
      reason:
        | "enumeration_incomplete"
        | "amount_coverage_partial"
        | "supply_inconsistency"
        | "input_metric_unavailable"
        | "absence_not_proven";
    };

export type SolanaSnapshotOwnerBalance =
  | { status: "positive_observed"; balanceRaw: string }
  | { status: "not_positive"; balanceRaw: "0"; basis: "complete_positive_owner_set" }
  | {
      status: "unknown";
      balanceRaw: null;
      reason: "enumeration_incomplete" | "amount_coverage_partial" | "supply_inconsistency";
    };

export interface SolanaHolderAuthorityComparison {
  authorityAddress: string;
  earlier: SolanaSnapshotOwnerBalance;
  later: SolanaSnapshotOwnerBalance;
  transition:
    | "positive_both"
    | "positive_earlier_only"
    | "positive_later_only"
    | "unknown_at_earlier"
    | "unknown_at_later"
    | "unknown_at_both";
  balanceDeltaRaw: SolanaSnapshotMetric<string>;
}

export type SolanaConcentrationDelta =
  | { status: "available"; percentagePointDelta: string; completeness: "complete" | "partial" }
  | {
      status: "unavailable";
      percentagePointDelta: null;
      reason: "earlier_unavailable" | "later_unavailable" | "both_unavailable";
      earlierReason: "zero_supply" | "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
      laterReason: "zero_supply" | "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
    };

export interface SolanaHolderSnapshotComparison {
  schemaVersion: "solana-holder-snapshot-comparison-v1";
  provenance: {
    earlierSnapshotId: string;
    laterSnapshotId: string;
    earlierEnumeration: { pageCount: number; contextSlots: number[]; slotConsistency: "not_guaranteed" };
    laterEnumeration: { pageCount: number; contextSlots: number[]; slotConsistency: "not_guaranteed" };
  };
  observedPositiveOwnerCountDelta: SolanaSnapshotMetric<number>;
  authorities: SolanaHolderAuthorityComparison[];
  concentrationPercentagePointDeltas: {
    top1: SolanaConcentrationDelta;
    top5: SolanaConcentrationDelta;
    top10: SolanaConcentrationDelta;
    top20: SolanaConcentrationDelta;
  };
}
