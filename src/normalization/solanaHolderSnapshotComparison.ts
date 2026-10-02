import { createHash } from "node:crypto";
import type { HolderConcentration, SolanaHolderStructure } from "../types/holders";
import type {
  DeepReadonly,
  SolanaConcentrationDelta,
  SolanaHolderAuthorityComparison,
  SolanaHolderSnapshotComparison,
  SolanaHolderSnapshotPayload,
  SolanaHolderSnapshotRecord,
  SolanaHolderSnapshotSource,
  SolanaSnapshotMetric,
  SolanaSnapshotOwnerBalance,
} from "../types/solanaHolderSnapshot";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

const RECORD_VERSION = "solana-holder-snapshot-record-v1" as const;
const COMPARISON_VERSION = "solana-holder-snapshot-comparison-v1" as const;
const DEFAULT_SOURCE: SolanaHolderSnapshotSource = {
  provider: "helius",
  method: "getProgramAccountsV2",
  commitment: "finalized",
};
const TOP_N = [1, 5, 10, 20] as const;
const NONNEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const SIGNED_INTEGER = /^(0|[1-9][0-9]*|-[1-9][0-9]*)$/;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Solana holder snapshot: ${message}`);
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalProjection(snapshot: SolanaHolderSnapshotPayload, source: SolanaHolderSnapshotSource): string {
  const amountCoverage = snapshot.amountCoverage;
  const concentration = snapshot.concentration;
  // This positional projection is deliberately versioned and explicit. Context slots
  // retain page order; owner authorities retain the normalizer's balance-rank order.
  const projection = [
    RECORD_VERSION,
    [source.provider, source.method, source.commitment],
    snapshot.chain,
    snapshot.mintAddress,
    snapshot.tokenProgram,
    snapshot.decimals,
    snapshot.currentMintSupplyRaw,
    snapshot.observedPositiveBalanceRaw,
    snapshot.supplyDifferenceRaw,
    snapshot.fetchedAt,
    [
      (snapshot.enumeration as { completeness: string }).completeness,
      snapshot.enumeration.slotConsistency,
      snapshot.enumeration.pageCount,
      snapshot.enumeration.contextSlots,
    ],
    snapshot.tokenAccountCount,
    snapshot.nonzeroTokenAccountCount,
    [
      snapshot.tokenAccountStateSummary.initialized.tokenAccountCount,
      snapshot.tokenAccountStateSummary.initialized.positiveBalanceTokenAccountCount,
      snapshot.tokenAccountStateSummary.initialized.observedBalanceRaw,
    ],
    [
      snapshot.tokenAccountStateSummary.frozen.tokenAccountCount,
      snapshot.tokenAccountStateSummary.frozen.positiveBalanceTokenAccountCount,
      snapshot.tokenAccountStateSummary.frozen.observedBalanceRaw,
    ],
    snapshot.rawOwnerCount,
    snapshot.rawOwnerAuthorities.map((owner) => [owner.ownerAddress, owner.balanceRaw, owner.tokenAccountCount]),
    [amountCoverage.state, amountCoverage.unsupportedExtensionTypes, amountCoverage.reason],
    TOP_N.map((n) => {
      const metric = concentration[`top${n}` as "top1" | "top5" | "top10" | "top20"];
      return metric.status === "available"
        ? [metric.status, metric.topN, metric.numeratorRaw, metric.denominatorRaw, metric.denominatorBasis, metric.percentage, null]
        : [metric.status, metric.topN, null, metric.denominatorRaw, metric.denominatorBasis, null, metric.reason];
    }),
  ];
  return JSON.stringify(projection);
}

export function calculateSolanaHolderSnapshotId(
  snapshot: SolanaHolderSnapshotPayload,
  source: SolanaHolderSnapshotSource = DEFAULT_SOURCE,
): string {
  return `sha256:${createHash("sha256").update(canonicalProjection(snapshot, source), "utf8").digest("hex")}`;
}

export function createSolanaHolderSnapshotRecord(
  snapshot: SolanaHolderStructure,
  source: SolanaHolderSnapshotSource = DEFAULT_SOURCE,
): SolanaHolderSnapshotRecord {
  validateSnapshot(snapshot);
  const frozenSnapshot = cloneAndFreeze(snapshot);
  const frozenSource = Object.freeze({ ...source });
  return Object.freeze({
    schemaVersion: RECORD_VERSION,
    snapshotId: calculateSolanaHolderSnapshotId(frozenSnapshot, frozenSource),
    source: frozenSource,
    snapshot: frozenSnapshot,
  });
}

function cloneAndFreeze<T>(value: T): DeepReadonly<T> {
  const clone: unknown = structuredClone(value);
  const freeze = (entry: unknown): unknown => {
    if (entry !== null && typeof entry === "object" && !Object.isFrozen(entry)) {
      for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(clone) as DeepReadonly<T>;
}

function expectedPercentage(numeratorRaw: string, denominatorRaw: string): string {
  const numerator = BigInt(numeratorRaw);
  const denominator = BigInt(denominatorRaw);
  const scale = 1_000_000n;
  const scaled = (numerator * 100n * scale + denominator / 2n) / denominator;
  return `${scaled / scale}.${(scaled % scale).toString().padStart(6, "0")}`;
}

function validateSnapshot(snapshot: SolanaHolderSnapshotPayload): void {
  assert(snapshot && typeof snapshot === "object", "snapshot payload is missing");
  assert(snapshot.chain === "solana", "chain must be solana");
  assert(isSolanaPublicKeySyntax(snapshot.mintAddress), "mint address is malformed");
  assert(snapshot.tokenProgram === "spl-token" || snapshot.tokenProgram === "token-2022", "token program is invalid");
  assert(Number.isInteger(snapshot.decimals) && snapshot.decimals >= 0 && snapshot.decimals <= 255, "decimals are invalid");
  assert(typeof snapshot.fetchedAt === "string" && Number.isFinite(Date.parse(snapshot.fetchedAt)), "fetchedAt is malformed");
  assert(typeof snapshot.currentMintSupplyRaw === "string" && NONNEGATIVE_INTEGER.test(snapshot.currentMintSupplyRaw), "current supply is not canonical");
  assert(typeof snapshot.observedPositiveBalanceRaw === "string" && NONNEGATIVE_INTEGER.test(snapshot.observedPositiveBalanceRaw), "observed balance is not canonical");
  assert(typeof snapshot.supplyDifferenceRaw === "string" && SIGNED_INTEGER.test(snapshot.supplyDifferenceRaw), "supply difference is not canonical");

  const enumeration = snapshot.enumeration as { completeness: string; slotConsistency: string; pageCount: number; contextSlots: number[] };
  assert(enumeration && (enumeration.completeness === "complete" || enumeration.completeness === "partial"), "enumeration completeness is invalid");
  assert(enumeration.slotConsistency === "not_guaranteed", "slot consistency must remain not_guaranteed");
  assert(isSafeCount(enumeration.pageCount) && enumeration.pageCount > 0, "page count is invalid");
  assert(Array.isArray(enumeration.contextSlots) && enumeration.contextSlots.length === enumeration.pageCount, "context slots do not reconcile with page count");
  assert(enumeration.contextSlots.every((slot) => isSafeCount(slot)), "context slot is invalid");

  const countFields = [snapshot.tokenAccountCount, snapshot.nonzeroTokenAccountCount, snapshot.rawOwnerCount];
  assert(countFields.every(isSafeCount), "account or owner count is invalid");
  assert(snapshot.nonzeroTokenAccountCount <= snapshot.tokenAccountCount, "nonzero account count exceeds account count");
  const stateValues = [snapshot.tokenAccountStateSummary?.initialized, snapshot.tokenAccountStateSummary?.frozen];
  assert(stateValues.every((state) => state && isSafeCount(state.tokenAccountCount) && isSafeCount(state.positiveBalanceTokenAccountCount) &&
    state.positiveBalanceTokenAccountCount <= state.tokenAccountCount && typeof state.observedBalanceRaw === "string" && NONNEGATIVE_INTEGER.test(state.observedBalanceRaw)), "token account state metrics are malformed");
  const [initialized, frozen] = stateValues;
  assert(initialized.tokenAccountCount + frozen.tokenAccountCount === snapshot.tokenAccountCount, "token account states do not reconcile");
  assert(initialized.positiveBalanceTokenAccountCount + frozen.positiveBalanceTokenAccountCount === snapshot.nonzeroTokenAccountCount, "positive token account states do not reconcile");
  const observed = BigInt(snapshot.observedPositiveBalanceRaw);
  assert(BigInt(initialized.observedBalanceRaw) + BigInt(frozen.observedBalanceRaw) === observed, "state balances do not reconcile with observed owner balances");

  assert(Array.isArray(snapshot.rawOwnerAuthorities), "owner authorities are missing");
  assert(snapshot.rawOwnerCount === snapshot.rawOwnerAuthorities.length, "raw owner count does not reconcile");
  const addresses = new Set<string>();
  let ownerSum = 0n;
  let previous: { address: string; balance: bigint } | null = null;
  for (const owner of snapshot.rawOwnerAuthorities) {
    assert(owner && isSolanaPublicKeySyntax(owner.ownerAddress), "owner authority is malformed");
    assert(!addresses.has(owner.ownerAddress), "duplicate owner authority");
    addresses.add(owner.ownerAddress);
    assert(typeof owner.balanceRaw === "string" && POSITIVE_INTEGER.test(owner.balanceRaw), "owner balance is not a canonical positive integer");
    assert(isSafeCount(owner.tokenAccountCount) && owner.tokenAccountCount > 0, "owner token account count is invalid");
    const balance = BigInt(owner.balanceRaw);
    if (previous) {
      assert(previous.balance > balance || (previous.balance === balance && previous.address < owner.ownerAddress), "owner authorities are not in deterministic normalized order");
    }
    previous = { address: owner.ownerAddress, balance };
    ownerSum += balance;
  }
  assert(ownerSum === observed, "owner balances do not reconcile with observed positive balance");
  assert(BigInt(snapshot.supplyDifferenceRaw) === BigInt(snapshot.currentMintSupplyRaw) - observed, "supply difference does not reconcile");
  assert(snapshot.rawOwnerAuthorities.reduce((sum, owner) => sum + owner.tokenAccountCount, 0) <= snapshot.tokenAccountCount, "owner account counts exceed enumerated account count");

  const coverage = snapshot.amountCoverage;
  assert(coverage && (coverage.state === "complete" || coverage.state === "partial"), "amount coverage state is invalid");
  assert(Array.isArray(coverage.unsupportedExtensionTypes) && coverage.unsupportedExtensionTypes.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 65535), "unsupported extension list is malformed");
  for (let i = 1; i < coverage.unsupportedExtensionTypes.length; i += 1) {
    assert(coverage.unsupportedExtensionTypes[i - 1] < coverage.unsupportedExtensionTypes[i], "unsupported extension list is not unique and sorted");
  }
  const supplyInconsistent = observed > BigInt(snapshot.currentMintSupplyRaw);
  if (supplyInconsistent) assert(coverage.state === "partial" && coverage.reason === "supply_inconsistency", "supply inconsistency must be marked partial");
  else if (coverage.reason === "supply_inconsistency") assert(false, "supply inconsistency reason has no observed contradiction");
  const hasUnsupported = coverage.unsupportedExtensionTypes.length > 0;
  if (hasUnsupported) assert(coverage.state === "partial" && coverage.reason === (supplyInconsistent ? "supply_inconsistency" : "unsupported_balance_affecting_extension"), "unsupported extensions do not reconcile with amount coverage");
  if (coverage.state === "complete") assert(coverage.reason === null && !supplyInconsistent && !hasUnsupported, "complete amount coverage contradicts its evidence");
  else assert(coverage.reason !== null, "partial amount coverage requires a reason");
  if (coverage.reason === "unsupported_balance_affecting_extension") assert(hasUnsupported, "unsupported-extension reason has no extension evidence");

  const expectedOwners = snapshot.rawOwnerAuthorities;
  for (const n of TOP_N) {
    const metric = snapshot.concentration[`top${n}` as "top1" | "top5" | "top10" | "top20"] as HolderConcentration;
    assert(metric && metric.topN === n && metric.denominatorBasis === "current_mint_supply" && metric.denominatorRaw === snapshot.currentMintSupplyRaw, `top${n} denominator or identity is invalid`);
    const unavailableReason = supplyInconsistent
      ? "supply_inconsistency"
      : coverage.state === "partial"
        ? "unsupported_balance_affecting_extension"
        : BigInt(snapshot.currentMintSupplyRaw) === 0n ? "zero_supply" : null;
    if (unavailableReason !== null) {
      assert(metric.status === "unavailable" && metric.numeratorRaw === null && metric.percentage === null && metric.reason === unavailableReason, `top${n} availability contradicts coverage`);
    } else {
      assert(metric.status === "available", `top${n} should be available`);
      const numerator = expectedOwners.slice(0, n).reduce((sum, owner) => sum + BigInt(owner.balanceRaw), 0n).toString();
      assert(metric.numeratorRaw === numerator && metric.percentage === expectedPercentage(numerator, snapshot.currentMintSupplyRaw), `top${n} concentration does not reconcile`);
    }
  }
}

function validateRecord(record: SolanaHolderSnapshotRecord): void {
  assert(record && record.schemaVersion === RECORD_VERSION, "unsupported record schema");
  assert(record.source && record.source.provider === "helius" && record.source.method === "getProgramAccountsV2" && record.source.commitment === "finalized", "source provenance is invalid");
  validateSnapshot(record.snapshot);
  assert(typeof record.snapshotId === "string" && /^sha256:[0-9a-f]{64}$/.test(record.snapshotId), "snapshot ID format is invalid");
  assert(record.snapshotId === calculateSolanaHolderSnapshotId(record.snapshot, record.source), "snapshot ID does not match its content");
}

function unavailableReason(snapshot: SolanaHolderSnapshotPayload): "enumeration_incomplete" | "amount_coverage_partial" | "supply_inconsistency" | null {
  if ((snapshot.enumeration as { completeness: string }).completeness !== "complete") return "enumeration_incomplete";
  if (snapshot.amountCoverage.reason === "supply_inconsistency" || BigInt(snapshot.observedPositiveBalanceRaw) > BigInt(snapshot.currentMintSupplyRaw)) return "supply_inconsistency";
  if (snapshot.amountCoverage.state !== "complete") return "amount_coverage_partial";
  return null;
}

function sideFor(snapshot: SolanaHolderSnapshotPayload, owner: string): SolanaSnapshotOwnerBalance {
  const observed = snapshot.rawOwnerAuthorities.find((candidate) => candidate.ownerAddress === owner);
  if (observed) return { status: "positive_observed", balanceRaw: observed.balanceRaw };
  const reason = unavailableReason(snapshot);
  return reason
    ? { status: "unknown", balanceRaw: null, reason }
    : { status: "not_positive", balanceRaw: "0", basis: "complete_positive_owner_set" };
}

function isKnown(side: SolanaSnapshotOwnerBalance): side is Extract<SolanaSnapshotOwnerBalance, { balanceRaw: string }> {
  return side.status === "positive_observed" || side.status === "not_positive";
}

function transition(earlier: SolanaSnapshotOwnerBalance, later: SolanaSnapshotOwnerBalance): SolanaHolderAuthorityComparison["transition"] {
  if (earlier.status === "unknown" && later.status === "unknown") return "unknown_at_both";
  if (earlier.status === "unknown") return "unknown_at_earlier";
  if (later.status === "unknown") return "unknown_at_later";
  if (earlier.status === "positive_observed" && later.status === "positive_observed") return "positive_both";
  if (earlier.status === "positive_observed") return "positive_earlier_only";
  if (later.status === "positive_observed") return "positive_later_only";
  // The union contains only authorities positive in at least one capture.
  throw new Error("Invalid Solana holder snapshot: authority union has no positive observation.");
}

function parsePercentageMicros(value: string): bigint {
  const match = /^(0|[1-9][0-9]*)\.([0-9]{6})$/.exec(value);
  if (!match) throw new Error("Invalid Solana holder snapshot: concentration percentage is not fixed to six decimals.");
  return BigInt(match[1]) * 1_000_000n + BigInt(match[2]);
}

function formatPercentageMicros(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}

function concentrationDelta(
  earlier: HolderConcentration,
  later: HolderConcentration,
  completeness: "complete" | "partial",
): SolanaConcentrationDelta {
  if (earlier.status === "available" && later.status === "available") {
    return {
      status: "available",
      percentagePointDelta: formatPercentageMicros(parsePercentageMicros(later.percentage) - parsePercentageMicros(earlier.percentage)),
      completeness,
    };
  }
  const earlierReason = earlier.status === "unavailable" ? earlier.reason : null;
  const laterReason = later.status === "unavailable" ? later.reason : null;
  return {
    status: "unavailable",
    percentagePointDelta: null,
    reason: earlierReason && laterReason ? "both_unavailable" : earlierReason ? "earlier_unavailable" : "later_unavailable",
    earlierReason,
    laterReason,
  };
}

export function compareSolanaHolderSnapshots(
  earlier: SolanaHolderSnapshotRecord,
  later: SolanaHolderSnapshotRecord,
): SolanaHolderSnapshotComparison {
  validateRecord(earlier);
  validateRecord(later);
  const first = earlier.snapshot;
  const second = later.snapshot;
  assert(first.chain === second.chain, "chain mismatch");
  assert(first.mintAddress === second.mintAddress, "mint mismatch");
  assert(first.tokenProgram === second.tokenProgram, "token program mismatch");
  assert(first.decimals === second.decimals, "decimals mismatch");
  const earlierTime = Date.parse(first.fetchedAt);
  const laterTime = Date.parse(second.fetchedAt);
  assert(earlierTime < laterTime, "caller order must have strictly increasing valid fetchedAt timestamps");

  const addresses = [...new Set([
    ...first.rawOwnerAuthorities.map((owner) => owner.ownerAddress),
    ...second.rawOwnerAuthorities.map((owner) => owner.ownerAddress),
  ])].sort();
  const authorities = addresses.map((authorityAddress): SolanaHolderAuthorityComparison => {
    const earlierSide = sideFor(first, authorityAddress);
    const laterSide = sideFor(second, authorityAddress);
    const delta: SolanaSnapshotMetric<string> = isKnown(earlierSide) && isKnown(laterSide)
      ? {
          status: "available",
          value: (BigInt(laterSide.balanceRaw) - BigInt(earlierSide.balanceRaw)).toString(),
          completeness: unavailableReason(first) || unavailableReason(second) ? "partial" : "complete",
        }
      : { status: "unavailable", value: null, reason: earlierSide.status === "unknown" || laterSide.status === "unknown" ? "absence_not_proven" : "input_metric_unavailable" };
    return { authorityAddress, earlier: earlierSide, later: laterSide, transition: transition(earlierSide, laterSide), balanceDeltaRaw: delta };
  });

  const countDelta: SolanaSnapshotMetric<number> = {
    status: "available",
    value: second.rawOwnerCount - first.rawOwnerCount,
    completeness: unavailableReason(first) || unavailableReason(second) ? "partial" : "complete",
  };
  const concentrationCompleteness = unavailableReason(first) === null && unavailableReason(second) === null ? "complete" : "partial";
  const metric = (key: "top1" | "top5" | "top10" | "top20") =>
    concentrationDelta(first.concentration[key], second.concentration[key], concentrationCompleteness);
  return {
    schemaVersion: COMPARISON_VERSION,
    provenance: {
      earlierSnapshotId: earlier.snapshotId,
      laterSnapshotId: later.snapshotId,
      earlierEnumeration: { pageCount: first.enumeration.pageCount, contextSlots: [...first.enumeration.contextSlots], slotConsistency: first.enumeration.slotConsistency },
      laterEnumeration: { pageCount: second.enumeration.pageCount, contextSlots: [...second.enumeration.contextSlots], slotConsistency: second.enumeration.slotConsistency },
    },
    observedPositiveOwnerCountDelta: countDelta,
    authorities,
    concentrationPercentagePointDeltas: { top1: metric("top1"), top5: metric("top5"), top10: metric("top10"), top20: metric("top20") },
  };
}
