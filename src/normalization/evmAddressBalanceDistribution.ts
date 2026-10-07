import type { EvmHolderEvidence } from "../types/evmHolders";
import type { EvmAddressBalanceDistribution, EvmAddressBalanceDistributionAvailable, EvmAddressBalanceDistributionPercentile, EvmCumulativeAddressBalanceProfilePoint, EvmRepeatedBalanceGroup } from "../types/evmAddressBalanceDistribution";
import type { EvmHolderStructure } from "../types/evmHolderStructure";
import { normalizeEvmAddress } from "../validation/evmAddress";

const UINT256_MAX = (1n << 256n) - 1n;
const MAX_REPEATED_BALANCE_GROUPS = 25;
const PERCENTAGE_SCALE = 1_000_000n;
const QUANTILES = [25, 50, 75, 90, 99] as const;
const PROFILE_PERCENTILES: readonly EvmAddressBalanceDistributionPercentile[] = [10, 25, 50, 75, 90, 99, 100];

export class EvmAddressBalanceDistributionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmAddressBalanceDistributionInputError";
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new EvmAddressBalanceDistributionInputError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCanonicalUint256(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 78) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return null;
  }
  if (value.length > 1 && value[0] === "0") return null;
  const parsed = BigInt(value);
  return parsed <= UINT256_MAX ? parsed : null;
}

function isCanonicalDecimal(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return value === "0" || value[0] !== "0";
}

function formatPercentage(numerator: bigint, denominator: bigint): string {
  const scaled = (numerator * 100n * PERCENTAGE_SCALE + denominator / 2n) / denominator;
  return `${(scaled / PERCENTAGE_SCALE).toString(10)}.${(scaled % PERCENTAGE_SCALE).toString(10).padStart(6, "0")}`;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCoverage(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function assertValidCoverage(evidence: EvmHolderEvidence): void {
  const coverage: unknown = evidence.coverage;
  assert(isRecord(coverage), "EVM holder coverage is malformed.");
  if (coverage.status === "provider_complete") {
    assert(Object.keys(coverage).length === 1, "EVM holder coverage is malformed.");
  } else if (coverage.status === "partial") {
    assert(Object.keys(coverage).length === 2
      && ["resource_limited", "provider_error", "malformed_response"].includes(String(coverage.reason)),
    "EVM holder coverage is malformed.");
  } else if (coverage.status === "unavailable") {
    assert(Object.keys(coverage).length === 2 && coverage.reason === "provider_error", "EVM holder coverage is malformed.");
  } else if (coverage.status === "malformed") {
    assert(Object.keys(coverage).length === 2 && coverage.reason === "malformed_response", "EVM holder coverage is malformed.");
  } else {
    throw new EvmAddressBalanceDistributionInputError("EVM holder coverage is malformed.");
  }
}

function validateFailureForCoverage(evidence: EvmHolderEvidence): void {
  const failure: unknown = evidence.failure;
  if (evidence.coverage.status === "provider_complete"
    || evidence.coverage.status === "partial" && evidence.coverage.reason === "resource_limited") {
    assert(failure === null, "EVM holder coverage contradicts failure evidence.");
    return;
  }
  assert(isRecord(failure) && typeof failure.category === "string"
    && ["configuration", "transport", "http", "provider", "malformed_response"].includes(failure.category)
    && (failure.httpStatus === null || Number.isSafeInteger(failure.httpStatus))
    && typeof failure.message === "string",
  "EVM holder failure evidence is malformed.");
  if (evidence.coverage.status === "malformed"
    || evidence.coverage.status === "partial" && evidence.coverage.reason === "malformed_response") {
    assert(failure.category === "malformed_response", "EVM malformed coverage contradicts failure evidence.");
  } else {
    assert(failure.category !== "malformed_response", "EVM provider-error coverage contradicts failure evidence.");
  }
}

function validatePaginationForCoverage(evidence: EvmHolderEvidence): void {
  const pagination = evidence.pagination;
  assert(isRecord(pagination) && Array.isArray(pagination.pages), "EVM holder pagination is malformed.");
  assert(Number.isSafeInteger(pagination.maxPages) && pagination.maxPages > 0
    && Number.isSafeInteger(pagination.maxRecords) && pagination.maxRecords > 0
    && Number.isSafeInteger(pagination.pagesRequested) && pagination.pagesRequested >= 0
    && Number.isSafeInteger(pagination.pagesReturned) && pagination.pagesReturned >= 0
    && Number.isSafeInteger(pagination.recordsRetained) && pagination.recordsRetained >= 0,
  "EVM holder pagination counts are malformed.");
  assert(pagination.providerRecordsReturned === null
    || Number.isSafeInteger(pagination.providerRecordsReturned) && pagination.providerRecordsReturned >= 0,
  "EVM provider record count is malformed.");
  for (const page of pagination.pages) {
    assert(isRecord(page) && Number.isSafeInteger(page.requestedPageNumber) && page.requestedPageNumber >= 0
      && Number.isSafeInteger(page.providerRecordsReturned) && page.providerRecordsReturned >= 0
      && Number.isSafeInteger(page.recordsRetained) && page.recordsRetained >= 0
      && page.recordsRetained <= page.providerRecordsReturned
      && page.providerReportedPageSize === 100 && typeof page.providerHasMore === "boolean",
    "EVM holder page evidence is malformed.");
  }
  assert(pagination.recordsRetained === evidence.holders.length
    && pagination.recordsRetained === pagination.pages.reduce((sum, page) => sum + page.recordsRetained, 0),
  "EVM page and retained holder counts do not reconcile.");
  assert(evidence.providerReportedHolderCount === pagination.providerReportedHolderCount,
    "EVM reported holder counts are inconsistent.");

  const acceptedPageCount = pagination.pages.length;
  const acceptedProviderRecordCount = pagination.pages.reduce((sum, page) => sum + page.providerRecordsReturned, 0);
  assert(pagination.pagesRequested <= pagination.maxPages
    && pagination.pagesReturned <= pagination.pagesRequested
    && acceptedPageCount <= pagination.pagesReturned
    && pagination.pages.every((page, index) => page.requestedPageNumber === index
      && page.providerRecordsReturned <= 100),
  "EVM holder page sequence or request counts are inconsistent.");
  assert((acceptedPageCount === 0
      && pagination.providerReportedPageSize === null
      && pagination.providerHasMore === null)
    || (acceptedPageCount > 0
      && pagination.providerReportedPageSize === 100
      && pagination.providerHasMore === pagination.pages[acceptedPageCount - 1].providerHasMore),
  "EVM top-level pagination state does not match accepted page evidence.");
  assert(pagination.providerRecordsReturned === null
    || pagination.providerRecordsReturned >= acceptedProviderRecordCount,
  "EVM provider record count is below accepted page evidence.");

  if (evidence.coverage.status === "provider_complete") {
    const reportedCount = pagination.providerReportedHolderCount;
    assert(evidence.failure === null
      && pagination.terminalReason === "natural_termination"
      && pagination.providerHasMore === false
      && pagination.requestedPageSize === 100
      && pagination.providerReportedPageSize === 100
      && pagination.pages.length > 0
      && pagination.pages.length <= pagination.maxPages
      && pagination.pagesRequested === pagination.pages.length
      && pagination.pagesReturned === pagination.pages.length
      && pagination.providerRecordsReturned !== null
      && pagination.providerRecordsReturned <= pagination.maxRecords
      && pagination.providerRecordsReturned === pagination.pages.reduce((sum, page) => sum + page.providerRecordsReturned, 0)
      && (reportedCount === null || isCanonicalDecimal(reportedCount)
        && BigInt(reportedCount) === BigInt(pagination.providerRecordsReturned))
      && pagination.pages.every((page, index) => page.providerHasMore === (index < pagination.pages.length - 1)),
    "EVM provider-complete coverage contradicts pagination evidence.");
  } else if (evidence.coverage.status === "partial" && evidence.coverage.reason === "resource_limited") {
    const terminal = pagination.terminalReason;
    const lastPage = pagination.pages[acceptedPageCount - 1];
    const capStateMatches = terminal === "page_cap"
      ? acceptedPageCount === pagination.maxPages
        && pagination.providerRecordsReturned !== null
        && pagination.providerRecordsReturned < pagination.maxRecords
        && lastPage?.providerHasMore === true
      : terminal === "record_cap"
        ? pagination.providerRecordsReturned !== null
          && pagination.providerRecordsReturned >= pagination.maxRecords
          && (lastPage?.providerHasMore === true
            ? acceptedPageCount < pagination.maxPages
            : pagination.providerRecordsReturned > pagination.maxRecords)
        : terminal === "page_and_record_caps"
          ? acceptedPageCount === pagination.maxPages
            && pagination.providerRecordsReturned !== null
            && pagination.providerRecordsReturned >= pagination.maxRecords
            && lastPage?.providerHasMore === true
          : false;
    assert(evidence.failure === null
      && capStateMatches
      && acceptedPageCount > 0
      && pagination.pagesRequested === acceptedPageCount
      && pagination.pagesReturned === acceptedPageCount
      && pagination.providerRecordsReturned !== null
      && pagination.providerRecordsReturned === acceptedProviderRecordCount
      && pagination.pages.slice(0, -1).every((page) => page.providerHasMore),
    "EVM resource-limited coverage contradicts pagination evidence.");
  } else if (evidence.coverage.status === "partial" && evidence.coverage.reason === "provider_error") {
    assert(evidence.failure !== null && evidence.failure.category !== "malformed_response"
      && pagination.terminalReason === "provider_error"
      && acceptedPageCount > 0
      && pagination.pagesRequested === acceptedPageCount + 1
      && pagination.pagesReturned === acceptedPageCount
      && pagination.providerRecordsReturned !== null
      && pagination.providerRecordsReturned === acceptedProviderRecordCount
      && pagination.providerHasMore === true
      && pagination.pages.every((page) => page.providerHasMore),
    "EVM provider-error partial coverage contradicts pagination evidence.");
  } else if (evidence.coverage.status === "partial" && evidence.coverage.reason === "malformed_response") {
    assert(evidence.failure !== null && evidence.failure.category === "malformed_response"
      && pagination.terminalReason === "malformed_response"
      && acceptedPageCount > 0
      && pagination.pagesRequested === acceptedPageCount + 1
      && (pagination.pagesReturned === acceptedPageCount || pagination.pagesReturned === acceptedPageCount + 1)
      && pagination.providerHasMore === true
      && pagination.pages.every((page) => page.providerHasMore),
    "EVM malformed-response partial coverage contradicts pagination evidence.");
  } else if (evidence.coverage.status === "unavailable") {
    assert(evidence.failure !== null && evidence.failure.category !== "malformed_response"
      && pagination.terminalReason === "provider_error"
      && acceptedPageCount === 0
      && pagination.pagesReturned === 0
      && (pagination.pagesRequested === 0 || pagination.pagesRequested === 1)
      && pagination.providerHasMore === null
      && pagination.providerRecordsReturned === 0,
    "EVM unavailable coverage contradicts pagination evidence.");
  } else if (evidence.coverage.status === "malformed") {
    assert(evidence.failure !== null && evidence.failure.category === "malformed_response"
      && pagination.terminalReason === "malformed_response"
      && acceptedPageCount === 0
      && pagination.pagesRequested === 1
      && (pagination.pagesReturned === 0 || pagination.pagesReturned === 1)
      && pagination.providerHasMore === null,
    "EVM malformed coverage contradicts pagination evidence.");
  }
}

function validateSource(
  evidence: EvmHolderEvidence,
  structure: EvmHolderStructure,
): { address: string; balance: bigint }[] {
  assert(isRecord(evidence) && isRecord(structure), "EVM holder distribution inputs are malformed.");
  assert(evidence.schemaVersion === "evm-holder-evidence-v1", "EVM holder evidence schema is unsupported.");
  assert(evidence.chain === "base" || evidence.chain === "ethereum", "EVM holder evidence chain is malformed.");
  assert(evidence.provenance?.chain === evidence.chain && evidence.provenance.provider === "goldrush",
    "EVM holder evidence provenance is inconsistent.");
  assert(evidence.provenance.providerChainSlug === (evidence.chain === "base" ? "base-mainnet" : "eth-mainnet"),
    "EVM holder provider chain provenance is inconsistent.");
  assert(typeof evidence.provenance.fetchedAt === "string" && Number.isFinite(Date.parse(evidence.provenance.fetchedAt)),
    "EVM holder fetch timestamp is malformed.");
  assert(evidence.provenance.providerBlockRelation === "match"
    || evidence.provenance.providerBlockRelation === "mismatch"
    || evidence.provenance.providerBlockRelation === "not_reported",
  "EVM holder block provenance is malformed.");
  assert(isCanonicalDecimal(evidence.provenance.requestedObservationBlock)
    && (evidence.provenance.providerReportedObservationBlock === null
      || isCanonicalDecimal(evidence.provenance.providerReportedObservationBlock)),
  "EVM holder observation block provenance is malformed.");
  assert((evidence.provenance.providerBlockRelation === "not_reported")
    === (evidence.provenance.providerReportedObservationBlock === null),
  "EVM holder block provenance is contradictory.");
  if (evidence.provenance.providerReportedObservationBlock !== null) {
    assert((evidence.provenance.providerBlockRelation === "match")
      === (evidence.provenance.requestedObservationBlock === evidence.provenance.providerReportedObservationBlock),
    "EVM holder block provenance is contradictory.");
  }

  const evidenceAddress = normalizeEvmAddress(evidence.tokenContractAddress);
  const provenanceAddress = normalizeEvmAddress(evidence.provenance.tokenContractAddress);
  const structureAddress = normalizeEvmAddress(structure.tokenContractAddress);
  assert(evidenceAddress !== null && evidenceAddress === evidence.tokenContractAddress
    && provenanceAddress === evidenceAddress && structureAddress === evidenceAddress,
  "EVM holder distribution contract identity is inconsistent.");
  assert(structure.tokenContractAddress === evidenceAddress, "EVM holder structure contract address is not normalized.");
  assert(structure.chain === evidence.chain,
    "EVM holder structure identity is inconsistent.");
  assert(Array.isArray(evidence.holders), "EVM holder observations are malformed.");
  assert(isRecord(evidence.pagination) && Array.isArray(evidence.pagination.pages), "EVM holder pagination is malformed.");
  assertValidCoverage(evidence);
  assert(sameCoverage(evidence.coverage, structure.goldRushCoverage),
    "EVM holder evidence and structure coverage do not match.");
  assert(Number.isSafeInteger(evidence.observedHolderRecordCount)
    && evidence.observedHolderRecordCount === evidence.holders.length
    && structure.observedHolderRecordCount === evidence.holders.length,
  "EVM holder evidence and structure record counts do not match.");
  assert(Number.isSafeInteger(evidence.observedPositiveBalanceAddressCount)
    && Number.isSafeInteger(structure.balanceBearingAddressCount),
  "EVM positive address counts are malformed.");
  validateFailureForCoverage(evidence);
  validatePaginationForCoverage(evidence);
  if (evidence.coverage.status === "unavailable" || evidence.coverage.status === "malformed") {
    assert(evidence.holders.length === 0,
      "EVM unavailable or malformed coverage contradicts accepted holder observations.");
  }

  const seen = new Set<string>();
  const positive: { address: string; balance: bigint }[] = [];
  for (const row of evidence.holders) {
    assert(isRecord(row), "EVM holder observation is malformed.");
    const normalizedAddress = normalizeEvmAddress(row.address);
    const balance = parseCanonicalUint256(row.rawBalance);
    assert(normalizedAddress !== null && normalizedAddress === row.address && balance !== null,
      "EVM holder observation address or raw balance is malformed.");
    assert(!seen.has(normalizedAddress), "EVM holder observations contain duplicate addresses.");
    seen.add(normalizedAddress);
    if (balance > 0n) positive.push({ address: normalizedAddress, balance });
  }
  positive.sort((left, right) => left.balance === right.balance
    ? left.address < right.address ? -1 : left.address > right.address ? 1 : 0
    : left.balance > right.balance ? -1 : 1);
  const observedTotal = positive.reduce((sum, row) => sum + row.balance, 0n);
  assert(evidence.observedPositiveBalanceAddressCount === positive.length
    && structure.balanceBearingAddressCount === positive.length,
  "EVM positive address counts do not match observations.");
  assert(structure.observedPositiveBalanceRaw === observedTotal.toString(10),
    "EVM observed positive balance total does not match holder evidence.");
  assert(Array.isArray(structure.rankedBalanceBearingAddresses)
    && structure.rankedBalanceBearingAddresses.length === positive.length,
  "EVM ranked positive addresses do not match holder evidence.");
  structure.rankedBalanceBearingAddresses.forEach((row, index) => {
    assert(isRecord(row) && row.address === positive[index].address
      && parseCanonicalUint256(row.balanceRaw)?.toString(10) === positive[index].balance.toString(10),
    "EVM ranked positive address evidence is inconsistent with holder observations.");
  });
  return positive;
}

function sourceBase(evidence: EvmHolderEvidence, structure: EvmHolderStructure) {
  return {
    chain: evidence.chain,
    tokenContractAddress: structure.tokenContractAddress,
    population: "positive_balance_addresses" as const,
    sourceCoverage: { ...evidence.coverage },
    sourceProvenance: { ...evidence.provenance },
    sourcePagination: { ...evidence.pagination, pages: evidence.pagination.pages.map((page) => ({ ...page })) },
    sourceHolderRecordCount: evidence.observedHolderRecordCount,
  };
}

function quantile(balancesAscending: readonly bigint[], percentile: number): string | null {
  if (balancesAscending.length === 0) return null;
  return balancesAscending[Math.ceil(percentile * balancesAscending.length / 100) - 1].toString(10);
}

function buildAvailableProfile(
  evidence: EvmHolderEvidence,
  structure: EvmHolderStructure,
  positiveDescending: readonly { address: string; balance: bigint }[],
): EvmAddressBalanceDistributionAvailable {
  const ascending = positiveDescending.map((row) => row.balance).sort(compareBigInt);
  const observedTotal = ascending.reduce((sum, balance) => sum + balance, 0n);
  const frequency = new Map<string, number>();
  for (const balance of ascending) {
    const raw = balance.toString(10);
    frequency.set(raw, (frequency.get(raw) ?? 0) + 1);
  }
  const allRepeatedGroups: EvmRepeatedBalanceGroup[] = [...frequency.entries()]
    .filter(([, count]) => count > 1)
    .map(([balanceRaw, addressCount]) => ({ balanceRaw, addressCount }))
    .sort((left, right) => right.addressCount - left.addressCount
      || compareBigInt(BigInt(left.balanceRaw), BigInt(right.balanceRaw)));
  const addressesInRepeatedBalanceGroups = allRepeatedGroups.reduce((sum, group) => sum + group.addressCount, 0);
  const cumulativeAddressBalanceProfile: EvmCumulativeAddressBalanceProfilePoint[] = [];
  let includedAddressCount = 0;
  let cumulative = 0n;
  for (const addressPercentile of PROFILE_PERCENTILES) {
    const targetCount = ascending.length === 0 ? 0 : Math.ceil(addressPercentile * ascending.length / 100);
    while (includedAddressCount < targetCount) {
      cumulative += ascending[includedAddressCount];
      includedAddressCount += 1;
    }
    cumulativeAddressBalanceProfile.push({
      addressPercentile,
      includedAddressCount,
      cumulativeObservedBalanceRaw: cumulative.toString(10),
      cumulativeObservedBalanceShare: observedTotal === 0n ? null : formatPercentage(cumulative, observedTotal),
    });
  }

  return {
    ...sourceBase(evidence, structure),
    status: "available",
    observedPositiveAddressCount: ascending.length,
    observedPositiveBalanceRaw: observedTotal.toString(10),
    minimumBalanceRaw: ascending[0]?.toString(10) ?? null,
    maximumBalanceRaw: ascending.at(-1)?.toString(10) ?? null,
    quantilesRaw: {
      p25: quantile(ascending, 25),
      p50: quantile(ascending, 50),
      p75: quantile(ascending, 75),
      p90: quantile(ascending, 90),
      p99: quantile(ascending, 99),
    },
    distinctBalanceCount: frequency.size,
    repeatedBalanceGroupCount: allRepeatedGroups.length,
    addressesInRepeatedBalanceGroups,
    addressShareInRepeatedBalanceGroups: ascending.length === 0
      ? null
      : formatPercentage(BigInt(addressesInRepeatedBalanceGroups), BigInt(ascending.length)),
    repeatedBalanceGroups: allRepeatedGroups.slice(0, MAX_REPEATED_BALANCE_GROUPS),
    repeatedBalanceGroupsOmitted: allRepeatedGroups.length - MAX_REPEATED_BALANCE_GROUPS > 0
      ? allRepeatedGroups.length - MAX_REPEATED_BALANCE_GROUPS
      : 0,
    cumulativeAddressBalanceProfile,
  };
}

/** Calculates descriptive statistics for observed EVM addresses without provider calls or owner inference. */
export function normalizeEvmAddressBalanceDistribution(
  evidence: EvmHolderEvidence,
  structure: EvmHolderStructure,
): EvmAddressBalanceDistribution {
  const positive = validateSource(evidence, structure);
  if (evidence.holders.length === 0 && evidence.coverage.status !== "provider_complete") {
    return {
      ...sourceBase(evidence, structure),
      status: "unavailable",
      reason: "no_accepted_holder_observations",
    };
  }
  return buildAvailableProfile(evidence, structure, positive);
}
