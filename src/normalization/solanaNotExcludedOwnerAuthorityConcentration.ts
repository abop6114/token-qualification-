import type { SolanaNotExcludedOwnerAuthorityPopulationEvidence } from "../types/solanaNotExcludedOwnerAuthorityPopulation";
import type {
  SolanaNotExcludedOwnerAuthorityConcentrationEvidence,
  SolanaNotExcludedTopN,
  SolanaNotExcludedTopNKey,
} from "../types/solanaNotExcludedOwnerAuthorityConcentration";
import { decodeSolanaPublicKey, encodeSolanaPublicKey, isSolanaPublicKeySyntax } from "../validation/solanaAddress";

const INPUT_VERSION = "solana-not-excluded-owner-authority-population-v1" as const;
const OUTPUT_VERSION = "solana-not-excluded-owner-authority-concentration-v1" as const;
const POLICY_VERSION = "solana-address-exclusion-policy-v1" as const;
const ASSESSMENT_VERSION = "solana-holder-exclusion-assessment-v1" as const;
const TOP_NS = [1, 5, 10, 20] as const;
const DECISIONS = ["exclude", "retain", "unresolved"] as const;
const UNSIGNED = /^(0|[1-9][0-9]*)$/;
const POSITIVE = /^[1-9][0-9]*$/;
const SIGNED = /^(0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const MAX_EXTENSION_TYPE = 65_535;

type Decision = (typeof DECISIONS)[number];
type Subject = SolanaNotExcludedOwnerAuthorityPopulationEvidence["subjects"][number];
type Totals = Record<Decision, { subjectCount: number; balance: bigint }>;
type TopNKey = SolanaNotExcludedTopNKey;

export class SolanaNotExcludedOwnerAuthorityConcentrationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaNotExcludedOwnerAuthorityConcentrationInputError";
  }
}

function fail(message: string): never {
  throw new SolanaNotExcludedOwnerAuthorityConcentrationInputError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesWhole(value: unknown, pattern: RegExp): value is string {
  if (typeof value !== "string") return false;
  const match = pattern.exec(value);
  return match !== null && match[0] === value;
}

function canonicalAddress(value: unknown): value is string {
  if (typeof value !== "string" || !isSolanaPublicKeySyntax(value)) return false;
  const decoded = decodeSolanaPublicKey(value);
  return decoded !== null && encodeSolanaPublicKey(decoded) === value;
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateInput(value: unknown): asserts value is SolanaNotExcludedOwnerAuthorityPopulationEvidence {
  if (!isRecord(value) || value.schemaVersion !== INPUT_VERSION || value.chain !== "solana"
    || !canonicalAddress(value.mintAddress) || value.policyVersion !== POLICY_VERSION
    || !isRecord(value.source) || !Array.isArray(value.subjects) || !isRecord(value.raw)
    || !isRecord(value.byDecision) || !isRecord(value.notExcluded) || !isRecord(value.reconciliation)) {
    fail("Step 5B-2 population evidence schema or identity is malformed.");
  }
  const source = value.source;
  if (source.exclusionAssessmentSchemaVersion !== ASSESSMENT_VERSION
    || !matchesWhole(source.holderSnapshotId, /^sha256:[0-9a-f]{64}$/)
    || !validTimestamp(source.holderFetchedAt)
    || !isRecord(source.enumeration) || source.enumeration.completeness !== "complete"
    || source.enumeration.slotConsistency !== "not_guaranteed"
    || !safeCount(source.enumeration.pageCount) || source.enumeration.pageCount < 1
    || !Array.isArray(source.enumeration.contextSlots)
    || source.enumeration.contextSlots.length !== source.enumeration.pageCount
    || !source.enumeration.contextSlots.every((slot) => safeCount(slot))) {
    fail("Step 5B-2 source provenance or enumeration is malformed.");
  }
  if (!isRecord(source.amountCoverage)
    || (source.amountCoverage.state !== "complete" && source.amountCoverage.state !== "partial")
    || !Array.isArray(source.amountCoverage.unsupportedExtensionTypes)
    || !source.amountCoverage.unsupportedExtensionTypes.every((extension) =>
      Number.isSafeInteger(extension) && (extension as number) >= 0 && (extension as number) <= MAX_EXTENSION_TYPE)
    || source.amountCoverage.unsupportedExtensionTypes.some((extension, index, all) =>
      index > 0 && (all[index - 1] as number) >= (extension as number))
    || !matchesWhole(source.currentMintSupplyRaw, UNSIGNED)
    || !matchesWhole(source.supplyDifferenceRaw, SIGNED)) {
    fail("Step 5B-2 amount coverage or supply evidence is malformed.");
  }

  const raw = value.raw;
  if (!safeCount(raw.subjectCount) || !matchesWhole(raw.observedPositiveBalanceRaw, UNSIGNED)) {
    fail("Step 5B-2 raw population summary is malformed.");
  }
  const sourceSupplyRaw = source.currentMintSupplyRaw as string;
  const sourceSupplyDifferenceRaw = source.supplyDifferenceRaw as string;
  const totals: Totals = {
    exclude: { subjectCount: 0, balance: 0n },
    retain: { subjectCount: 0, balance: 0n },
    unresolved: { subjectCount: 0, balance: 0n },
  };
  const seen = new Set<string>();
  let previousAddress: string | null = null;
  let rawBalance = 0n;
  let notExcludedBalance = 0n;
  let notExcludedCount = 0;

  for (const candidate of value.subjects) {
    if (!isRecord(candidate) || !canonicalAddress(candidate.subjectAddress)
      || !matchesWhole(candidate.balanceRaw, POSITIVE)
      || !DECISIONS.includes(candidate.decision as Decision)
      || seen.has(candidate.subjectAddress)
      || (previousAddress !== null && previousAddress >= candidate.subjectAddress)) {
      fail("Step 5B-2 subject ordering, identity, balance, or decision is malformed.");
    }
    if (candidate.decision === "exclude") {
      fail("The current Step 5B-2 policy cannot contain exclude decisions.");
    }
    seen.add(candidate.subjectAddress);
    previousAddress = candidate.subjectAddress;
    const balance = BigInt(candidate.balanceRaw);
    rawBalance += balance;
    const total = totals[candidate.decision as Decision];
    total.subjectCount += 1;
    total.balance += balance;
    notExcludedCount += 1;
    notExcludedBalance += balance;
  }

  if (raw.subjectCount !== value.subjects.length || rawBalance.toString() !== raw.observedPositiveBalanceRaw
    || (BigInt(sourceSupplyRaw) - rawBalance).toString() !== sourceSupplyDifferenceRaw) {
    fail("Step 5B-2 raw totals or supply difference do not reconcile with subjects.");
  }
  for (const decision of DECISIONS) {
    const supplied = value.byDecision[decision];
    if (!isRecord(supplied) || !safeCount(supplied.subjectCount)
      || !matchesWhole(supplied.observedBalanceRaw, UNSIGNED)
      || supplied.subjectCount !== totals[decision].subjectCount
      || supplied.observedBalanceRaw !== totals[decision].balance.toString()) {
      fail("Step 5B-2 decision totals do not reconcile with subjects.");
    }
  }
  if (Object.keys(value.byDecision).length !== DECISIONS.length) {
    fail("Step 5B-2 decision summary contains unexpected categories.");
  }
  if (!safeCount(value.notExcluded.subjectCount)
    || !matchesWhole(value.notExcluded.observedBalanceRaw, UNSIGNED)
    || value.notExcluded.subjectCount !== notExcludedCount
    || value.notExcluded.observedBalanceRaw !== notExcludedBalance.toString()) {
    fail("Step 5B-2 not-excluded totals do not reconcile with subjects.");
  }
  if (value.reconciliation.status !== "reconciled"
    || value.reconciliation.basis !== "decision_categories_partition_observed_positive_owner_authority_rows") {
    fail("Step 5B-2 reconciliation evidence is malformed.");
  }

  const supply = BigInt(sourceSupplyRaw);
  const supplyDifference = BigInt(sourceSupplyDifferenceRaw);
  const extensions = source.amountCoverage.unsupportedExtensionTypes;
  const reason = source.amountCoverage.reason as string | null;
  const hasSupplyInconsistency = supplyDifference < 0n;
  const hasUnsupportedExtensions = extensions.length > 0;
  if (source.amountCoverage.state === "complete") {
    if (reason !== null || hasUnsupportedExtensions || hasSupplyInconsistency) {
      fail("Complete amount coverage contradicts source evidence.");
    }
  } else {
    const expectedReason = hasSupplyInconsistency
      ? "supply_inconsistency"
      : hasUnsupportedExtensions
        ? "unsupported_balance_affecting_extension"
        : null;
    if (expectedReason === null || reason !== expectedReason) {
      fail("Partial amount coverage contradicts source evidence.");
    }
  }
  if (supplyDifference !== supply - rawBalance) {
    fail("Supply consistency does not reconcile with observed raw balances.");
  }
}

function rankAndSumTopN(subjects: readonly Subject[]): Record<TopNKey, { topN: SolanaNotExcludedTopN; numeratorRaw: string }> {
  // The public boundary validates canonical balances and addresses before this pure ranking step.
  const ranked = [...subjects]
    .filter((subject) => subject.decision !== "exclude")
    .sort((left, right) => {
      const leftBalance = BigInt(left.balanceRaw);
      const rightBalance = BigInt(right.balanceRaw);
      if (leftBalance !== rightBalance) return leftBalance > rightBalance ? -1 : 1;
      return left.subjectAddress < right.subjectAddress ? -1 : left.subjectAddress > right.subjectAddress ? 1 : 0;
    });
  const result = {} as Record<TopNKey, { topN: SolanaNotExcludedTopN; numeratorRaw: string }>;
  for (const topN of TOP_NS) {
    const numerator = ranked.slice(0, topN).reduce((sum, subject) => sum + BigInt(subject.balanceRaw), 0n);
    result[`top${topN}` as TopNKey] = { topN, numeratorRaw: numerator.toString(10) };
  }
  return result;
}

function percentage(numeratorRaw: string, denominatorRaw: string): string {
  const numerator = BigInt(numeratorRaw);
  const denominator = BigInt(denominatorRaw);
  const scale = 1_000_000n;
  const scaled = (numerator * 100n * scale + denominator / 2n) / denominator;
  return `${scaled / scale}.${(scaled % scale).toString().padStart(6, "0")}`;
}

function makeAvailableTopN(
  sums: Record<TopNKey, { topN: SolanaNotExcludedTopN; numeratorRaw: string }>,
  denominatorRaw: string,
): Record<TopNKey, { topN: SolanaNotExcludedTopN; numeratorRaw: string; percentage: string }> {
  return Object.fromEntries(TOP_NS.map((topN) => {
    const key = `top${topN}` as TopNKey;
    const value = sums[key];
    return [key, {
      topN: value.topN,
      numeratorRaw: value.numeratorRaw,
      percentage: percentage(value.numeratorRaw, denominatorRaw),
    }];
  })) as Record<TopNKey, { topN: SolanaNotExcludedTopN; numeratorRaw: string; percentage: string }>;
}

function makeUnavailableTopN(
  sums: Record<TopNKey, { topN: SolanaNotExcludedTopN; numeratorRaw: string }>,
): Record<TopNKey, { topN: SolanaNotExcludedTopN; numeratorRaw: string; percentage: null }> {
  return Object.fromEntries(TOP_NS.map((topN) => {
    const key = `top${topN}` as TopNKey;
    const value = sums[key];
    return [key, { topN: value.topN, numeratorRaw: value.numeratorRaw, percentage: null }];
  })) as Record<TopNKey, { topN: SolanaNotExcludedTopN; numeratorRaw: string; percentage: null }>;
}

function cloneEnumeration(value: SolanaNotExcludedOwnerAuthorityPopulationEvidence["source"]["enumeration"]) {
  return { ...value, contextSlots: [...value.contextSlots] };
}

function cloneAmountCoverage(value: SolanaNotExcludedOwnerAuthorityPopulationEvidence["source"]["amountCoverage"]) {
  return { ...value, unsupportedExtensionTypes: [...value.unsupportedExtensionTypes] };
}

/** Calculates additive Solana not-excluded concentration evidence from Step 5B-2 evidence only. */
export function deriveSolanaNotExcludedOwnerAuthorityConcentration(
  input: SolanaNotExcludedOwnerAuthorityPopulationEvidence,
): SolanaNotExcludedOwnerAuthorityConcentrationEvidence {
  validateInput(input);

  const rankedSums = rankAndSumTopN(input.subjects);
  const supplyRaw = input.source.currentMintSupplyRaw;
  const supply = BigInt(supplyRaw);
  const supplyDifference = BigInt(input.source.supplyDifferenceRaw);
  const notExcludedBalanceRaw = input.notExcluded.observedBalanceRaw;
  const notExcludedBalance = BigInt(notExcludedBalanceRaw);
  const partialReasons: Array<"unsupported_balance_affecting_extension" | "supply_inconsistency"> = [];
  if (input.source.amountCoverage.unsupportedExtensionTypes.length > 0) {
    partialReasons.push("unsupported_balance_affecting_extension");
  }
  if (supplyDifference < 0n) partialReasons.push("supply_inconsistency");
  const bCompleteness: "complete" | "partial" = partialReasons.length === 0 ? "complete" : "partial";

  const aReason: "supply_inconsistency" | "zero_supply" | "partial_amount_coverage" | null = supplyDifference < 0n
    ? "supply_inconsistency"
    : supply === 0n
      ? "zero_supply"
      : input.source.amountCoverage.state === "partial"
        ? "partial_amount_coverage"
        : null;
  const a = aReason === null
    ? {
        status: "available" as const,
        basis: "current_mint_supply" as const,
        denominatorRaw: supplyRaw,
        completeness: "complete" as const,
        ...makeAvailableTopN(rankedSums, supplyRaw),
      }
    : {
        status: "unavailable" as const,
        basis: "current_mint_supply" as const,
        denominatorRaw: supplyRaw,
        reason: aReason,
        ...makeUnavailableTopN(rankedSums),
      };

  const bAvailable = notExcludedBalance > 0n;
  const b = bAvailable
    ? {
        status: "available" as const,
        basis: "not_excluded_observed_balance_total" as const,
        denominatorRaw: notExcludedBalanceRaw,
        completeness: bCompleteness,
        partialReasons,
        unsupportedExtensionTypes: [...input.source.amountCoverage.unsupportedExtensionTypes],
        ...makeAvailableTopN(rankedSums, notExcludedBalanceRaw),
      }
    : {
        status: "unavailable" as const,
        basis: "not_excluded_observed_balance_total" as const,
        denominatorRaw: "0" as const,
        reason: "zero_not_excluded_observed_balance_total" as const,
        completeness: bCompleteness,
        partialReasons,
        unsupportedExtensionTypes: [...input.source.amountCoverage.unsupportedExtensionTypes],
        ...makeUnavailableTopN(rankedSums),
      };

  return {
    schemaVersion: OUTPUT_VERSION,
    chain: "solana",
    mintAddress: input.mintAddress,
    policyVersion: input.policyVersion,
    source: {
      populationSchemaVersion: input.schemaVersion,
      holderSnapshotId: input.source.holderSnapshotId,
      exclusionAssessmentSchemaVersion: input.source.exclusionAssessmentSchemaVersion,
      holderFetchedAt: input.source.holderFetchedAt,
      enumeration: cloneEnumeration(input.source.enumeration),
      amountCoverage: cloneAmountCoverage(input.source.amountCoverage),
      currentMintSupplyRaw: supplyRaw,
      supplyDifferenceRaw: input.source.supplyDifferenceRaw,
      holderSupplyAlignment: "not_proven_atomic",
    },
    population: {
      subjectType: "observed_positive_solana_owner_authorities",
      rawSubjectCount: input.raw.subjectCount,
      rawObservedBalanceRaw: input.raw.observedPositiveBalanceRaw,
      byDecision: {
        exclude: { ...input.byDecision.exclude },
        retain: { ...input.byDecision.retain },
        unresolved: { ...input.byDecision.unresolved },
      },
      notExcludedSubjectCount: input.notExcluded.subjectCount,
      notExcludedObservedBalanceRaw: notExcludedBalanceRaw,
    },
    notExcludedTopNCurrentMintSupplyShare: a,
    notExcludedObservedPopulationTopNShare: b,
  };
}
