import type { HolderConcentration } from "./holders";
import type {
  SolanaHolderSnapshotRecord,
  SolanaSnapshotMetric,
  SolanaSnapshotOwnerBalance,
} from "./solanaHolderSnapshot";

export interface SolanaHolderSnapshotSeries {
  readonly schemaVersion: "solana-holder-snapshot-series-v1";
  readonly captures: readonly SolanaHolderSnapshotRecord[];
}

export interface SolanaHolderSnapshotSeriesCaptureReference {
  readonly snapshotId: string;
  readonly fetchedAt: string;
  readonly pageCount: number;
  readonly contextSlots: readonly number[];
}

export interface SolanaHolderAuthoritySeriesCapture {
  readonly snapshotId: string;
  readonly state: SolanaSnapshotOwnerBalance;
}

export interface SolanaHolderAuthoritySeriesEvidence {
  readonly authorityAddress: string;
  readonly captures: readonly SolanaHolderAuthoritySeriesCapture[];
  readonly positiveObservedCaptureCount: number;
  readonly provenNotPositiveCaptureCount: number;
  readonly unknownCaptureCount: number;
  readonly positiveAtEveryCapture: "yes" | "no" | "unknown";
  readonly positiveAtBothEndpoints: "yes" | "no" | "unknown";
}

export type SolanaHolderSeriesConcentrationMetric =
  | { readonly status: "available"; readonly percentage: string; readonly completeness: "complete" | "partial" }
  | {
      readonly status: "unavailable";
      readonly percentage: null;
      readonly reason: Extract<HolderConcentration, { status: "unavailable" }>["reason"];
    };

export interface SolanaHolderSnapshotSeriesEvidence {
  readonly schemaVersion: "solana-holder-snapshot-series-evidence-v1";
  readonly captures: readonly SolanaHolderSnapshotSeriesCaptureReference[];
  /** Elapsed time between first and last capture timestamps; not a continuous observation duration. */
  readonly elapsedCaptureSpanMilliseconds: number;
  readonly authorities: readonly SolanaHolderAuthoritySeriesEvidence[];
  readonly observedPositiveOwnerCountTrajectory: readonly SolanaSnapshotMetric<number>[];
  readonly adjacentObservedPositiveOwnerCountDeltas: readonly SolanaSnapshotMetric<number>[];
  readonly concentrationTrajectory: readonly {
    readonly top1: SolanaHolderSeriesConcentrationMetric;
    readonly top5: SolanaHolderSeriesConcentrationMetric;
    readonly top10: SolanaHolderSeriesConcentrationMetric;
    readonly top20: SolanaHolderSeriesConcentrationMetric;
  }[];
}
