import { createHash } from "node:crypto";
import type { HolderConcentration, SolanaHolderStructure, SolanaPartialHolderStructure } from "../types/holders";
import type {
  DeepReadonly,
  SolanaConcentrationDelta,
  SolanaHolderAuthorityComparison,
  SolanaHolderSnapshotComparison,
  SolanaHolderSnapshotPayload,
  SolanaHolderSnapshotRecord,
  SolanaHolderSnapshotAcquisitionV2,
  SolanaHolderSnapshotPayloadV2,
  SolanaHolderSnapshotRecordV2,
  SolanaHolderSnapshotRecordVersioned,
  SolanaHolderSnapshotComparisonV2,
  PartialHolderConcentrationV2,
  SolanaHolderSnapshotSource,
  SolanaSnapshotMetric,
  SolanaSnapshotOwnerBalance,
} from "../types/solanaHolderSnapshot";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

const RECORD_VERSION = "solana-holder-snapshot-record-v1" as const;
const COMPARISON_VERSION = "solana-holder-snapshot-comparison-v1" as const;
const RECORD_VERSION_V2 = "solana-holder-snapshot-record-v2" as const;
const COMPARISON_VERSION_V2 = "solana-holder-snapshot-comparison-v2" as const;
const DEFAULT_SOURCE: SolanaHolderSnapshotSource = {
  provider: "helius",
  method: "getProgramAccountsV2",
  commitment: "finalized",
};
const TOP_N = [1, 5, 10, 20] as const;
const NONNEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const SIGNED_INTEGER = /^(0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const V2_PARTIAL_STOP_REASONS = new Set(["page_cap", "request_timeout", "provider_error", "malformed_response"]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Solana holder snapshot: ${message}`);
}

function assertExactKeys(value: unknown, expected: readonly string[], description: string): void {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${description} is malformed`);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  assert(actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]), `${description} contains unexpected fields`);
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

function canonicalProjectionV2(
  snapshot: SolanaHolderSnapshotPayloadV2,
  source: SolanaHolderSnapshotSource,
  acquisition: SolanaHolderSnapshotAcquisitionV2,
): string {
  return JSON.stringify([
    RECORD_VERSION_V2,
    [acquisition.completeness, acquisition.stopReason, acquisition.configuredMaxPages, acquisition.requestedPageSize],
    JSON.parse(canonicalProjection(snapshot as unknown as SolanaHolderSnapshotPayload, source)),
  ]);
}

export function calculateSolanaHolderSnapshotId(
  snapshot: SolanaHolderSnapshotPayload,
  source: SolanaHolderSnapshotSource = DEFAULT_SOURCE,
): string {
  return `sha256:${createHash("sha256").update(canonicalProjection(snapshot, source), "utf8").digest("hex")}`;
}

export function calculateSolanaHolderSnapshotIdV2(
  snapshot: SolanaHolderSnapshotPayloadV2,
  source: SolanaHolderSnapshotSource,
  acquisition: SolanaHolderSnapshotAcquisitionV2,
): string {
  return `sha256:${createHash("sha256").update(canonicalProjectionV2(snapshot, source, acquisition), "utf8").digest("hex")}`;
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

function projectV2Snapshot(snapshot: SolanaHolderStructure | SolanaPartialHolderStructure): SolanaHolderSnapshotPayloadV2 {
  const input = snapshot as SolanaHolderStructure | SolanaPartialHolderStructure;
  const concentrationMetric = (metric: HolderConcentration | PartialHolderConcentrationV2) => metric.status === "available"
    ? { status: metric.status, topN: metric.topN, numeratorRaw: metric.numeratorRaw, denominatorRaw: metric.denominatorRaw, denominatorBasis: metric.denominatorBasis, percentage: metric.percentage }
    : { status: metric.status, topN: metric.topN, numeratorRaw: metric.numeratorRaw, denominatorRaw: metric.denominatorRaw, denominatorBasis: metric.denominatorBasis, percentage: metric.percentage, reason: metric.reason };
  return structuredClone({
    chain: input.chain,
    mintAddress: input.mintAddress,
    tokenProgram: input.tokenProgram,
    decimals: input.decimals,
    currentMintSupplyRaw: input.currentMintSupplyRaw,
    observedPositiveBalanceRaw: input.observedPositiveBalanceRaw,
    supplyDifferenceRaw: input.supplyDifferenceRaw,
    fetchedAt: input.fetchedAt,
    enumeration: {
      completeness: input.enumeration.completeness,
      slotConsistency: input.enumeration.slotConsistency,
      pageCount: input.enumeration.pageCount,
      contextSlots: [...input.enumeration.contextSlots],
    },
    tokenAccountCount: input.tokenAccountCount,
    nonzeroTokenAccountCount: input.nonzeroTokenAccountCount,
    tokenAccountStateSummary: {
      initialized: {
        tokenAccountCount: input.tokenAccountStateSummary.initialized.tokenAccountCount,
        positiveBalanceTokenAccountCount: input.tokenAccountStateSummary.initialized.positiveBalanceTokenAccountCount,
        observedBalanceRaw: input.tokenAccountStateSummary.initialized.observedBalanceRaw,
      },
      frozen: {
        tokenAccountCount: input.tokenAccountStateSummary.frozen.tokenAccountCount,
        positiveBalanceTokenAccountCount: input.tokenAccountStateSummary.frozen.positiveBalanceTokenAccountCount,
        observedBalanceRaw: input.tokenAccountStateSummary.frozen.observedBalanceRaw,
      },
    },
    rawOwnerCount: input.rawOwnerCount,
    rawOwnerAuthorities: input.rawOwnerAuthorities.map((owner) => ({
      ownerAddress: owner.ownerAddress,
      balanceRaw: owner.balanceRaw,
      tokenAccountCount: owner.tokenAccountCount,
    })),
    amountCoverage: {
      state: input.amountCoverage.state,
      unsupportedExtensionTypes: [...input.amountCoverage.unsupportedExtensionTypes],
      reason: input.amountCoverage.reason,
    },
    concentration: {
      top1: concentrationMetric(input.concentration.top1),
      top5: concentrationMetric(input.concentration.top5),
      top10: concentrationMetric(input.concentration.top10),
      top20: concentrationMetric(input.concentration.top20),
    },
  }) as SolanaHolderSnapshotPayloadV2;
}

function validateV2Acquisition(
  snapshot: SolanaHolderSnapshotPayloadV2,
  acquisition: SolanaHolderSnapshotAcquisitionV2,
): void {
  assert(acquisition && typeof acquisition === "object", "v2 acquisition provenance is missing");
  assertExactKeys(acquisition, ["completeness", "stopReason", "configuredMaxPages", "requestedPageSize"], "v2 acquisition provenance");
  assert(acquisition.completeness === "complete" || acquisition.completeness === "partial", "v2 acquisition completeness is invalid");
  assert(acquisition.configuredMaxPages === 20 && acquisition.requestedPageSize === 5000, "v2 acquisition bounds are invalid");
  const enumeration = snapshot.enumeration;
  assert(enumeration.pageCount > 0 && enumeration.pageCount <= acquisition.configuredMaxPages, "v2 accepted page count is invalid");
  assert(enumeration.contextSlots.length === enumeration.pageCount, "v2 context slots do not reconcile with accepted pages");
  if (acquisition.completeness === "complete") {
    assert(enumeration.completeness === "complete" && acquisition.stopReason === "provider_terminated", "complete v2 provenance contradicts enumeration");
  } else {
    assert(enumeration.completeness === "partial", "partial v2 provenance contradicts enumeration");
    assert(V2_PARTIAL_STOP_REASONS.has((acquisition as { stopReason: string }).stopReason), "partial v2 stop reason is invalid");
    assert(acquisition.stopReason === "page_cap" ? enumeration.pageCount === 20 : enumeration.pageCount < 20,
      "partial v2 accepted page count contradicts its stop reason");
  }
}

export function createSolanaHolderSnapshotRecordV2(
  snapshot: SolanaHolderStructure,
  acquisition: SolanaHolderSnapshotAcquisitionV2,
  source?: SolanaHolderSnapshotSource,
): SolanaHolderSnapshotRecordV2;
export function createSolanaHolderSnapshotRecordV2(
  snapshot: SolanaPartialHolderStructure,
  acquisition?: never,
  source?: SolanaHolderSnapshotSource,
): SolanaHolderSnapshotRecordV2;
export function createSolanaHolderSnapshotRecordV2(
  snapshot: SolanaHolderStructure | SolanaPartialHolderStructure,
  acquisition?: SolanaHolderSnapshotAcquisitionV2,
  source: SolanaHolderSnapshotSource = DEFAULT_SOURCE,
): SolanaHolderSnapshotRecordV2 {
  const embeddedAcquisition = "acquisition" in snapshot ? snapshot.acquisition : undefined;
  let resolvedAcquisition: SolanaHolderSnapshotAcquisitionV2;
  if (embeddedAcquisition) resolvedAcquisition = { completeness: "partial", ...embeddedAcquisition };
  else {
    assert(acquisition !== undefined, "complete v2 acquisition provenance must be explicit");
    resolvedAcquisition = acquisition;
  }
  assert(!embeddedAcquisition || acquisition === undefined, "partial v2 acquisition must come from its holder input");
  assertExactKeys(source, ["provider", "method", "commitment"], "source provenance");
  assert(source.provider === "helius" && source.method === "getProgramAccountsV2" && source.commitment === "finalized", "source provenance is invalid");
  const projected = projectV2Snapshot(snapshot);
  validateSnapshot(projected as unknown as SolanaHolderSnapshotPayload, true);
  validateV2Acquisition(projected, resolvedAcquisition);
  const frozenSnapshot = cloneAndFreeze(projected);
  const frozenSource = Object.freeze({ ...source });
  const frozenAcquisition = Object.freeze({ ...resolvedAcquisition });
  return Object.freeze({
    schemaVersion: RECORD_VERSION_V2,
    snapshotId: calculateSolanaHolderSnapshotIdV2(frozenSnapshot, frozenSource, frozenAcquisition),
    source: frozenSource,
    acquisition: frozenAcquisition,
    snapshot: frozenSnapshot,
  });
}

function expectedPercentage(numeratorRaw: string, denominatorRaw: string): string {
  const numerator = BigInt(numeratorRaw);
  const denominator = BigInt(denominatorRaw);
  const scale = 1_000_000n;
  const scaled = (numerator * 100n * scale + denominator / 2n) / denominator;
  return `${scaled / scale}.${(scaled % scale).toString().padStart(6, "0")}`;
}

function validateSnapshot(snapshot: SolanaHolderSnapshotPayload, allowPartialEnumeration = false): void {
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
    const zeroSupply = BigInt(snapshot.currentMintSupplyRaw) === 0n;
    if (allowPartialEnumeration && enumeration.completeness === "partial") {
      assert(metric.status === "unavailable" && metric.numeratorRaw === null && metric.percentage === null
        && (metric as unknown as PartialHolderConcentrationV2).reason === "enumeration_incomplete", `top${n} partial enumeration concentration must remain unavailable`);
      continue;
    }
    if (metric.status === "available") {
      assert(!supplyInconsistent && !zeroSupply, `top${n} cannot be numerically available with inconsistent or zero supply`);
      if (coverage.state === "partial") {
        assert(coverage.reason === "unsupported_balance_affecting_extension" && hasUnsupported, `top${n} partial numeric evidence requires an unsupported-extension reason`);
      }
      const numerator = expectedOwners.slice(0, n).reduce((sum, owner) => sum + BigInt(owner.balanceRaw), 0n).toString();
      assert(metric.numeratorRaw === numerator && metric.percentage === expectedPercentage(numerator, snapshot.currentMintSupplyRaw), `top${n} concentration does not reconcile`);
    } else {
      if (coverage.state === "partial" && !supplyInconsistent) {
        assert(
          coverage.reason === "unsupported_balance_affecting_extension" && hasUnsupported,
          `top${n} unavailable concentration requires valid partial-coverage evidence`,
        );
      }
      const expectedReason = supplyInconsistent
        ? "supply_inconsistency"
        : zeroSupply
          ? "zero_supply"
          : coverage.state === "partial" ? "unsupported_balance_affecting_extension" : null;
      assert(metric.numeratorRaw === null && metric.percentage === null && expectedReason !== null && metric.reason === expectedReason, `top${n} availability contradicts coverage`);
    }
  }
}

export function validateSolanaHolderSnapshotRecord(record: SolanaHolderSnapshotRecord): void {
  assert(record && record.schemaVersion === RECORD_VERSION, "unsupported record schema");
  assert(record.source && record.source.provider === "helius" && record.source.method === "getProgramAccountsV2" && record.source.commitment === "finalized", "source provenance is invalid");
  validateSnapshot(record.snapshot);
  assert(typeof record.snapshotId === "string" && /^sha256:[0-9a-f]{64}$/.test(record.snapshotId), "snapshot ID format is invalid");
  assert(record.snapshotId === calculateSolanaHolderSnapshotId(record.snapshot, record.source), "snapshot ID does not match its content");
}

export function validateSolanaHolderSnapshotRecordV2(record: SolanaHolderSnapshotRecordV2): void {
  assert(record && record.schemaVersion === RECORD_VERSION_V2, "unsupported v2 record schema");
  assertExactKeys(record, ["schemaVersion", "snapshotId", "source", "acquisition", "snapshot"], "v2 record");
  assert(record.source && record.source.provider === "helius" && record.source.method === "getProgramAccountsV2" && record.source.commitment === "finalized", "source provenance is invalid");
  assertExactKeys(record.source, ["provider", "method", "commitment"], "source provenance");
  assertExactKeys(record.acquisition, ["completeness", "stopReason", "configuredMaxPages", "requestedPageSize"], "v2 acquisition provenance");
  assert(record.snapshot && typeof record.snapshot === "object" && !Object.hasOwn(record.snapshot, "acquisition"), "v2 snapshot contains duplicated or unsafe acquisition data");
  assertExactKeys(record.snapshot, ["chain", "mintAddress", "tokenProgram", "decimals", "currentMintSupplyRaw", "observedPositiveBalanceRaw", "supplyDifferenceRaw", "fetchedAt", "enumeration", "tokenAccountCount", "nonzeroTokenAccountCount", "tokenAccountStateSummary", "rawOwnerCount", "rawOwnerAuthorities", "amountCoverage", "concentration"], "v2 snapshot");
  assertExactKeys(record.snapshot.enumeration, ["completeness", "slotConsistency", "pageCount", "contextSlots"], "v2 enumeration");
  assertExactKeys(record.snapshot.tokenAccountStateSummary, ["initialized", "frozen"], "v2 token-account state summary");
  assertExactKeys(record.snapshot.tokenAccountStateSummary.initialized, ["tokenAccountCount", "positiveBalanceTokenAccountCount", "observedBalanceRaw"], "v2 initialized state");
  assertExactKeys(record.snapshot.tokenAccountStateSummary.frozen, ["tokenAccountCount", "positiveBalanceTokenAccountCount", "observedBalanceRaw"], "v2 frozen state");
  assertExactKeys(record.snapshot.amountCoverage, ["state", "unsupportedExtensionTypes", "reason"], "v2 amount coverage");
  assertExactKeys(record.snapshot.concentration, ["top1", "top5", "top10", "top20"], "v2 concentration");
  for (const n of TOP_N) {
    const metric = record.snapshot.concentration[`top${n}` as "top1" | "top5" | "top10" | "top20"];
    assertExactKeys(metric, metric.status === "available"
      ? ["status", "topN", "numeratorRaw", "denominatorRaw", "denominatorBasis", "percentage"]
      : ["status", "topN", "numeratorRaw", "denominatorRaw", "denominatorBasis", "percentage", "reason"], `v2 top${n} concentration`);
  }
  for (const owner of record.snapshot.rawOwnerAuthorities) {
    assertExactKeys(owner, ["ownerAddress", "balanceRaw", "tokenAccountCount"], "v2 owner balance");
  }
  validateSnapshot(record.snapshot as unknown as SolanaHolderSnapshotPayload, true);
  validateV2Acquisition(record.snapshot, record.acquisition);
  assert(typeof record.snapshotId === "string" && /^sha256:[0-9a-f]{64}$/.test(record.snapshotId), "snapshot ID format is invalid");
  assert(record.snapshotId === calculateSolanaHolderSnapshotIdV2(record.snapshot, record.source, record.acquisition), "snapshot ID does not match its content");
}

export function validateSolanaHolderSnapshotRecordVersioned(record: SolanaHolderSnapshotRecordVersioned): void {
  if (record?.schemaVersion === RECORD_VERSION) validateSolanaHolderSnapshotRecord(record);
  else if (record?.schemaVersion === RECORD_VERSION_V2) validateSolanaHolderSnapshotRecordV2(record);
  else assert(false, "unsupported record schema");
}

function unavailableReason(snapshot: SolanaHolderSnapshotPayload | SolanaHolderSnapshotPayloadV2): "enumeration_incomplete" | "amount_coverage_partial" | "supply_inconsistency" | null {
  if ((snapshot.enumeration as { completeness: string }).completeness !== "complete") return "enumeration_incomplete";
  if (snapshot.amountCoverage.reason === "supply_inconsistency" || BigInt(snapshot.observedPositiveBalanceRaw) > BigInt(snapshot.currentMintSupplyRaw)) return "supply_inconsistency";
  if (snapshot.amountCoverage.state !== "complete") return "amount_coverage_partial";
  return null;
}

/** Pure resolver for already validated holder evidence. Callers validate the record at their public boundary. */
export function resolveSolanaSnapshotOwnerBalance(
  snapshot: SolanaHolderSnapshotPayload | SolanaHolderSnapshotPayloadV2,
  owner: string,
): SolanaSnapshotOwnerBalance {
  const observed = snapshot.rawOwnerAuthorities.find((candidate) => candidate.ownerAddress === owner);
  if (observed) return { status: "positive_observed", balanceRaw: observed.balanceRaw };
  const reason = unavailableReason(snapshot);
  return reason
    ? { status: "unknown", balanceRaw: null, reason }
    : { status: "not_positive", balanceRaw: "0", basis: "complete_positive_owner_set" };
}

/** Completeness gate for metrics over a snapshot's positive-owner set. */
export function getSolanaHolderEvidenceCompleteness(snapshot: SolanaHolderSnapshotPayload | SolanaHolderSnapshotPayloadV2): "complete" | "partial" {
  return unavailableReason(snapshot) === null ? "complete" : "partial";
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
  earlier: HolderConcentration | PartialHolderConcentrationV2,
  later: HolderConcentration | PartialHolderConcentrationV2,
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
  validateSolanaHolderSnapshotRecord(earlier);
  validateSolanaHolderSnapshotRecord(later);
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
    const earlierSide = resolveSolanaSnapshotOwnerBalance(first, authorityAddress);
    const laterSide = resolveSolanaSnapshotOwnerBalance(second, authorityAddress);
    const evidenceCompleteness = getSolanaHolderEvidenceCompleteness(first) === "complete" &&
      getSolanaHolderEvidenceCompleteness(second) === "complete" ? "complete" : "partial";
    const delta: SolanaSnapshotMetric<string> = isKnown(earlierSide) && isKnown(laterSide)
      ? {
          status: "available",
          value: (BigInt(laterSide.balanceRaw) - BigInt(earlierSide.balanceRaw)).toString(),
          completeness: evidenceCompleteness,
        }
      : { status: "unavailable", value: null, reason: earlierSide.status === "unknown" || laterSide.status === "unknown" ? "absence_not_proven" : "input_metric_unavailable" };
    return { authorityAddress, earlier: earlierSide, later: laterSide, transition: transition(earlierSide, laterSide), balanceDeltaRaw: delta };
  });

  const countDelta: SolanaSnapshotMetric<number> = {
    status: "available",
    value: second.rawOwnerCount - first.rawOwnerCount,
    completeness: getSolanaHolderEvidenceCompleteness(first) === "complete" &&
      getSolanaHolderEvidenceCompleteness(second) === "complete" ? "complete" : "partial",
  };
  const concentrationCompleteness = getSolanaHolderEvidenceCompleteness(first) === "complete" &&
    getSolanaHolderEvidenceCompleteness(second) === "complete" ? "complete" : "partial";
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

function comparisonCore(first: SolanaHolderSnapshotPayload | SolanaHolderSnapshotPayloadV2, second: SolanaHolderSnapshotPayload | SolanaHolderSnapshotPayloadV2) {
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
  const evidenceCompleteness = getSolanaHolderEvidenceCompleteness(first) === "complete" &&
    getSolanaHolderEvidenceCompleteness(second) === "complete" ? "complete" : "partial";
  const authorities = addresses.map((authorityAddress): SolanaHolderAuthorityComparison => {
    const earlierSide = resolveSolanaSnapshotOwnerBalance(first, authorityAddress);
    const laterSide = resolveSolanaSnapshotOwnerBalance(second, authorityAddress);
    const delta: SolanaSnapshotMetric<string> = isKnown(earlierSide) && isKnown(laterSide)
      ? { status: "available", value: (BigInt(laterSide.balanceRaw) - BigInt(earlierSide.balanceRaw)).toString(), completeness: evidenceCompleteness }
      : { status: "unavailable", value: null, reason: earlierSide.status === "unknown" || laterSide.status === "unknown" ? "absence_not_proven" : "input_metric_unavailable" };
    return { authorityAddress, earlier: earlierSide, later: laterSide, transition: transition(earlierSide, laterSide), balanceDeltaRaw: delta };
  });
  const countDelta: SolanaSnapshotMetric<number> = {
    status: "available", value: second.rawOwnerCount - first.rawOwnerCount, completeness: evidenceCompleteness,
  };
  const metric = (key: "top1" | "top5" | "top10" | "top20") => concentrationDelta(first.concentration[key], second.concentration[key], evidenceCompleteness);
  return {
    earlierEnumeration: { pageCount: first.enumeration.pageCount, contextSlots: [...first.enumeration.contextSlots], slotConsistency: first.enumeration.slotConsistency as "not_guaranteed" },
    laterEnumeration: { pageCount: second.enumeration.pageCount, contextSlots: [...second.enumeration.contextSlots], slotConsistency: second.enumeration.slotConsistency as "not_guaranteed" },
    observedPositiveOwnerCountDelta: countDelta,
    authorities,
    concentrationPercentagePointDeltas: { top1: metric("top1"), top5: metric("top5"), top10: metric("top10"), top20: metric("top20") },
  };
}

function versionProvenance(record: SolanaHolderSnapshotRecordVersioned) {
  return record.schemaVersion === RECORD_VERSION_V2
    ? { schemaVersion: RECORD_VERSION_V2, acquisition: record.acquisition } as const
    : { schemaVersion: RECORD_VERSION, acquisition: { status: "not_recorded", reason: "legacy_v1_schema" } } as const;
}

export function compareSolanaHolderSnapshotsV2(
  earlier: SolanaHolderSnapshotRecordVersioned,
  later: SolanaHolderSnapshotRecordVersioned,
): SolanaHolderSnapshotComparisonV2 {
  validateSolanaHolderSnapshotRecordVersioned(earlier);
  validateSolanaHolderSnapshotRecordVersioned(later);
  const core = comparisonCore(earlier.snapshot, later.snapshot);
  return {
    schemaVersion: COMPARISON_VERSION_V2,
    provenance: {
      earlierSnapshotId: earlier.snapshotId,
      laterSnapshotId: later.snapshotId,
      earlierRecord: versionProvenance(earlier),
      laterRecord: versionProvenance(later),
      earlierEnumeration: core.earlierEnumeration,
      laterEnumeration: core.laterEnumeration,
    },
    observedPositiveOwnerCountDelta: core.observedPositiveOwnerCountDelta,
    authorities: core.authorities,
    concentrationPercentagePointDeltas: core.concentrationPercentagePointDeltas,
  };
}
