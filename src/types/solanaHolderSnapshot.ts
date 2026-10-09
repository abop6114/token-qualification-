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

export type SolanaHolderSnapshotAcquisitionV2 =
  | {
      readonly completeness: "complete";
      readonly stopReason: "provider_terminated";
      readonly configuredMaxPages: 20;
      readonly requestedPageSize: 5000;
    }
  | {
      readonly completeness: "partial";
      readonly stopReason: "page_cap" | "request_timeout" | "provider_error" | "malformed_response";
      readonly configuredMaxPages: 20;
      readonly requestedPageSize: 5000;
    };

export type PartialHolderConcentrationV2 = {
  readonly status: "unavailable";
  readonly topN: 1 | 5 | 10 | 20;
  readonly numeratorRaw: null;
  readonly denominatorRaw: string;
  readonly denominatorBasis: "current_mint_supply";
  readonly percentage: null;
  readonly reason: "enumeration_incomplete";
};

/** V2 stores only normalized holder evidence and safe acquisition provenance. */
export type SolanaHolderSnapshotPayloadV2 = DeepReadonly<
  Omit<SolanaHolderStructure, "enumeration" | "concentration"> & {
    enumeration: {
      completeness: "complete" | "partial";
      slotConsistency: "not_guaranteed";
      pageCount: number;
      contextSlots: number[];
    };
    concentration: {
      top1: SolanaHolderStructure["concentration"]["top1"] | PartialHolderConcentrationV2;
      top5: SolanaHolderStructure["concentration"]["top5"] | PartialHolderConcentrationV2;
      top10: SolanaHolderStructure["concentration"]["top10"] | PartialHolderConcentrationV2;
      top20: SolanaHolderStructure["concentration"]["top20"] | PartialHolderConcentrationV2;
    };
  }
>;

export interface SolanaHolderSnapshotRecordV2 {
  readonly schemaVersion: "solana-holder-snapshot-record-v2";
  readonly snapshotId: string;
  readonly source: SolanaHolderSnapshotSource;
  readonly acquisition: SolanaHolderSnapshotAcquisitionV2;
  readonly snapshot: SolanaHolderSnapshotPayloadV2;
}

export type SolanaHolderSnapshotRecordVersioned = SolanaHolderSnapshotRecord | SolanaHolderSnapshotRecordV2;

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
      earlierReason: "zero_supply" | "unsupported_balance_affecting_extension" | "supply_inconsistency" | "enumeration_incomplete" | null;
      laterReason: "zero_supply" | "unsupported_balance_affecting_extension" | "supply_inconsistency" | "enumeration_incomplete" | null;
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

export type SolanaHolderSnapshotVersionProvenance =
  | { readonly schemaVersion: "solana-holder-snapshot-record-v1"; readonly acquisition: { readonly status: "not_recorded"; readonly reason: "legacy_v1_schema" } }
  | { readonly schemaVersion: "solana-holder-snapshot-record-v2"; readonly acquisition: SolanaHolderSnapshotAcquisitionV2 };

export interface SolanaHolderSnapshotComparisonV2 {
  readonly schemaVersion: "solana-holder-snapshot-comparison-v2";
  readonly provenance: {
    readonly earlierSnapshotId: string;
    readonly laterSnapshotId: string;
    readonly earlierRecord: SolanaHolderSnapshotVersionProvenance;
    readonly laterRecord: SolanaHolderSnapshotVersionProvenance;
    readonly earlierEnumeration: { readonly pageCount: number; readonly contextSlots: readonly number[]; readonly slotConsistency: "not_guaranteed" };
    readonly laterEnumeration: { readonly pageCount: number; readonly contextSlots: readonly number[]; readonly slotConsistency: "not_guaranteed" };
  };
  readonly observedPositiveOwnerCountDelta: SolanaSnapshotMetric<number>;
  readonly authorities: readonly SolanaHolderAuthorityComparison[];
  readonly concentrationPercentagePointDeltas: {
    readonly top1: SolanaConcentrationDelta;
    readonly top5: SolanaConcentrationDelta;
    readonly top10: SolanaConcentrationDelta;
    readonly top20: SolanaConcentrationDelta;
  };
}
