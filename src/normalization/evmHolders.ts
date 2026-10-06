import type { EvmBalanceHolderObservation } from "../types/evmHolders";
import { normalizeEvmAddress } from "../validation/evmAddress";

const UINT256_MAX = (1n << 256n) - 1n;

export class EvmHolderNormalizationError extends Error {
  constructor(message = "GoldRush holder page is malformed.") {
    super(message);
    this.name = "EvmHolderNormalizationError";
  }
}

export interface NormalizedGoldRushHolderPage {
  requestedPageNumber: number;
  providerPageNumber: number;
  providerPageSize: 100;
  providerHasMore: boolean;
  providerRecordsReturned: number;
  providerReportedHolderCount: string | null;
  providerReportedObservationBlock: string | null;
  holders: EvmBalanceHolderObservation[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalUnsignedDecimal(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return null;
  }
  return BigInt(value).toString(10);
}

function normalizeProviderInteger(value: unknown): string | null {
  if (typeof value === "string") return canonicalUnsignedDecimal(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value).toString(10);
  return null;
}

/** Canonical exact decimal input used for requested EVM block heights. */
export function normalizeEvmHolderBlockInput(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > 1 && value[0] === "0") return null;
  const normalized = canonicalUnsignedDecimal(value);
  return normalized === value ? value : null;
}

export function normalizeGoldRushHolderPage(
  value: unknown,
  expected: { chainSlug: string; tokenAddress: string; requestedPageNumber: number; maxRecordsToNormalize: number },
): NormalizedGoldRushHolderPage {
  if (!isObject(value) || !Array.isArray(value.items) || !isObject(value.pagination)) {
    throw new EvmHolderNormalizationError();
  }
  if (hasOwn(value, "chain_name") && (typeof value.chain_name !== "string" || value.chain_name !== expected.chainSlug)) {
    throw new EvmHolderNormalizationError();
  }
  const pagination = value.pagination;
  const pageNumber = pagination.page_number;
  const pageSize = pagination.page_size;
  const hasMore = pagination.has_more;
  if (!Number.isSafeInteger(pageNumber) || pageNumber !== expected.requestedPageNumber
    || pageSize !== 100 || hasMore !== true && hasMore !== false) {
    throw new EvmHolderNormalizationError();
  }
  if (!Number.isSafeInteger(expected.maxRecordsToNormalize) || expected.maxRecordsToNormalize < 0
    || value.items.length > 100 || (hasMore && value.items.length === 0)) {
    throw new EvmHolderNormalizationError();
  }

  let reportedCount: string | null = null;
  if (hasOwn(pagination, "total_count")) {
    if (pagination.total_count !== null) {
      reportedCount = normalizeProviderInteger(pagination.total_count);
      if (reportedCount === null) throw new EvmHolderNormalizationError();
      const endIndex = BigInt(pageNumber) * 100n + BigInt(value.items.length);
      const total = BigInt(reportedCount);
      if (total < endIndex || (hasMore && total <= endIndex) || (!hasMore && total > endIndex)) {
        throw new EvmHolderNormalizationError();
      }
    }
  }

  const holders: EvmBalanceHolderObservation[] = [];
  let reportedBlock: string | null = null;
  const acceptBlock = (candidate: unknown): void => {
    const normalized = normalizeProviderInteger(candidate);
    if (normalized === null || (reportedBlock !== null && normalized !== reportedBlock)) {
      throw new EvmHolderNormalizationError();
    }
    reportedBlock = normalized;
  };
  if (hasOwn(value, "block_height")) acceptBlock(value.block_height);

  const providerRecordsToNormalize = Math.min(value.items.length, expected.maxRecordsToNormalize);
  for (let itemIndex = 0; itemIndex < providerRecordsToNormalize; itemIndex += 1) {
    const rawHolder = value.items[itemIndex];
    if (!isObject(rawHolder)) throw new EvmHolderNormalizationError();
    const address = normalizeEvmAddress(rawHolder.address);
    const rawBalance = canonicalUnsignedDecimal(rawHolder.balance);
    if (address === null || rawBalance === null || BigInt(rawBalance) > UINT256_MAX) {
      throw new EvmHolderNormalizationError();
    }
    if (!hasOwn(rawHolder, "contract_address")) throw new EvmHolderNormalizationError();
    const contractAddress = normalizeEvmAddress(rawHolder.contract_address);
    if (contractAddress === null || contractAddress !== expected.tokenAddress) throw new EvmHolderNormalizationError();
    if (hasOwn(rawHolder, "block_height")) acceptBlock(rawHolder.block_height);
    holders.push({ address, rawBalance });
  }

  return {
    requestedPageNumber: expected.requestedPageNumber,
    providerPageNumber: pageNumber,
    providerPageSize: 100,
    providerHasMore: hasMore,
    providerRecordsReturned: value.items.length,
    providerReportedHolderCount: reportedCount,
    providerReportedObservationBlock: reportedBlock,
    holders,
  };
}
