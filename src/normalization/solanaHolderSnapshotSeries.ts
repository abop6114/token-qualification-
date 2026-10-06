import type { HolderConcentration } from "../types/holders";
import type {
  SolanaHolderAuthoritySeriesEvidence,
  SolanaHolderSeriesConcentrationMetric,
  SolanaHolderSnapshotSeries,
  SolanaHolderSnapshotSeriesEvidence,
  SolanaHolderSnapshotSeriesCaptureReference,
} from "../types/solanaHolderSnapshotSeries";
import type { SolanaSnapshotMetric, SolanaSnapshotOwnerBalance } from "../types/solanaHolderSnapshot";
import {
  getSolanaHolderEvidenceCompleteness,
  resolveSolanaSnapshotOwnerBalance,
  validateSolanaHolderSnapshotRecord,
} from "./solanaHolderSnapshotComparison";

const SERIES_VERSION = "solana-holder-snapshot-series-v1" as const;
const EVIDENCE_VERSION = "solana-holder-snapshot-series-evidence-v1" as const;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Solana holder snapshot series: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function triStateEvery(states: readonly SolanaSnapshotOwnerBalance[]): "yes" | "no" | "unknown" {
  if (states.every((state) => state.status === "positive_observed")) return "yes";
  if (states.some((state) => state.status === "not_positive")) return "no";
  return "unknown";
}

function triStateEndpoints(states: readonly SolanaSnapshotOwnerBalance[]): "yes" | "no" | "unknown" {
  const first = states[0];
  const last = states[states.length - 1];
  if (first.status === "positive_observed" && last.status === "positive_observed") return "yes";
  if (first.status === "not_positive" || last.status === "not_positive") return "no";
  return "unknown";
}

function concentrationMetric(
  metric: HolderConcentration,
  completeness: "complete" | "partial",
): SolanaHolderSeriesConcentrationMetric {
  if (metric.status === "unavailable") {
    return { status: "unavailable", percentage: null, reason: metric.reason };
  }
  return { status: "available", percentage: metric.percentage, completeness };
}

function ownerCountMetric(value: number, completeness: "complete" | "partial"): SolanaSnapshotMetric<number> {
  return { status: "available", value, completeness };
}

function orderedCaptureReferences(
  series: SolanaHolderSnapshotSeries,
): SolanaHolderSnapshotSeriesCaptureReference[] {
  return series.captures.map(({ snapshotId, snapshot }) => ({
    snapshotId,
    fetchedAt: snapshot.fetchedAt,
    pageCount: snapshot.enumeration.pageCount,
    contextSlots: [...snapshot.enumeration.contextSlots],
  }));
}

function validateSeries(series: SolanaHolderSnapshotSeries): number[] {
  assert(series && series.schemaVersion === SERIES_VERSION, "unsupported series schema");
  assert(Array.isArray(series.captures) && series.captures.length >= 2, "at least two captures are required");
  for (const capture of series.captures) validateSolanaHolderSnapshotRecord(capture);
  const snapshotIds = new Set<string>();
  const first = series.captures[0].snapshot;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  const timestamps: number[] = [];

  for (const capture of series.captures) {
    assert(!snapshotIds.has(capture.snapshotId), "duplicate snapshot ID");
    snapshotIds.add(capture.snapshotId);
    const snapshot = capture.snapshot;
    assert(snapshot.chain === first.chain, "chain mismatch");
    assert(snapshot.mintAddress === first.mintAddress, "mint mismatch");
    assert(snapshot.tokenProgram === first.tokenProgram, "token program mismatch");
    assert(snapshot.decimals === first.decimals, "decimals mismatch");
    const timestamp = Date.parse(snapshot.fetchedAt);
    assert(Number.isSafeInteger(timestamp), "capture timestamp is not a safe millisecond value");
    assert(timestamp > previousTimestamp, "captures must remain in strictly increasing caller-provided timestamp order");
    previousTimestamp = timestamp;
    timestamps.push(timestamp);
  }
  return timestamps;
}

export function buildSolanaHolderSnapshotSeriesEvidence(
  series: SolanaHolderSnapshotSeries,
): SolanaHolderSnapshotSeriesEvidence {
  const timestamps = validateSeries(series);
  const elapsedBigInt = BigInt(timestamps[timestamps.length - 1]) - BigInt(timestamps[0]);
  assert(elapsedBigInt > 0n && elapsedBigInt <= MAX_SAFE_BIGINT, "elapsed capture span exceeds safe millisecond precision");

  const snapshots = series.captures.map((capture) => capture.snapshot);
  const completeness = snapshots.map(getSolanaHolderEvidenceCompleteness);
  const captureReferences = orderedCaptureReferences(series);
  const authorityAddresses = [...new Set(snapshots.flatMap((snapshot) =>
    snapshot.rawOwnerAuthorities.map((owner) => owner.ownerAddress)))].sort();

  const authorities: SolanaHolderAuthoritySeriesEvidence[] = authorityAddresses.map((authorityAddress) => {
    const states = snapshots.map((snapshot): SolanaSnapshotOwnerBalance =>
      resolveSolanaSnapshotOwnerBalance(snapshot, authorityAddress));
    return {
      authorityAddress,
      captures: states.map((state, index) => ({ snapshotId: series.captures[index].snapshotId, state })),
      positiveObservedCaptureCount: states.filter((state) => state.status === "positive_observed").length,
      provenNotPositiveCaptureCount: states.filter((state) => state.status === "not_positive").length,
      unknownCaptureCount: states.filter((state) => state.status === "unknown").length,
      positiveAtEveryCapture: triStateEvery(states),
      positiveAtBothEndpoints: triStateEndpoints(states),
    };
  });

  const observedPositiveOwnerCountTrajectory = snapshots.map((snapshot, index) =>
    ownerCountMetric(snapshot.rawOwnerCount, completeness[index]));
  const adjacentObservedPositiveOwnerCountDeltas = snapshots.slice(1).map((snapshot, index) => {
    const delta = snapshot.rawOwnerCount - snapshots[index].rawOwnerCount;
    assert(Number.isSafeInteger(delta), "observed owner-count delta exceeds safe integer precision");
    return ownerCountMetric(delta, completeness[index] === "complete" && completeness[index + 1] === "complete" ? "complete" : "partial");
  });
  const concentrationTrajectory = snapshots.map((snapshot, index) => ({
    top1: concentrationMetric(snapshot.concentration.top1, completeness[index]),
    top5: concentrationMetric(snapshot.concentration.top5, completeness[index]),
    top10: concentrationMetric(snapshot.concentration.top10, completeness[index]),
    top20: concentrationMetric(snapshot.concentration.top20, completeness[index]),
  }));

  return deepFreeze({
    schemaVersion: EVIDENCE_VERSION,
    captures: captureReferences,
    elapsedCaptureSpanMilliseconds: Number(elapsedBigInt),
    authorities,
    observedPositiveOwnerCountTrajectory,
    adjacentObservedPositiveOwnerCountDeltas,
    concentrationTrajectory,
  });
}
