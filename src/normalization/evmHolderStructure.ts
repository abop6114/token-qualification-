import type { EvmHolderEvidence } from "../types/evmHolders";
import type {
  EvmHolderStructure,
  EvmPositiveBalanceAddress,
  EvmSupplyReconciliation,
  EvmTopNSupplyConcentration,
} from "../types/evmHolderStructure";
import type { EvmTokenContractEvidence } from "../types/evmToken";
import { normalizeEvmAddress } from "../validation/evmAddress";

const UINT256_MAX = (1n << 256n) - 1n;
const TOKEN_EVIDENCE_SCHEMA = "evm-token-contract-evidence-v1";
const HOLDER_EVIDENCE_SCHEMA = "evm-holder-evidence-v1";
const TOP_N = [1, 5, 10, 20] as const;

export class EvmHolderStructureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmHolderStructureInputError";
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new EvmHolderStructureInputError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function parseCanonicalUint256(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 78) return null;
  for (let index = 0; index < value.length; index += 1) {
    const digit = value.charCodeAt(index);
    if (digit < 48 || digit > 57) return null;
  }
  if (value.length > 1 && value[0] === "0") return null;
  const parsed = BigInt(value);
  return parsed <= UINT256_MAX ? parsed : null;
}

function parseCanonicalDecimalBlock(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length === 0) return null;
  for (let index = 0; index < value.length; index += 1) {
    const digit = value.charCodeAt(index);
    if (digit < 48 || digit > 57) return null;
  }
  if (value.length > 1 && value[0] === "0") return null;
  return BigInt(value);
}

function parseCanonicalHexBlock(value: unknown): bigint | null {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  const digits = value.slice(2);
  if (digits.length === 0 || (digits.length > 1 && digits[0] === "0")) return null;
  for (let index = 0; index < digits.length; index += 1) {
    const code = digits.charCodeAt(index);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102))) return null;
  }
  const parsed = BigInt(value);
  return parsed <= UINT256_MAX ? parsed : null;
}

function assertProviderErrorEvidence(value: unknown): void {
  assert(isRecord(value)
    && ["configuration", "transport", "http", "rpc", "malformed_response"].includes(String(value.category))
    && (value.httpStatus === null || Number.isSafeInteger(value.httpStatus))
    && (value.rpcCode === null || Number.isSafeInteger(value.rpcCode))
    && typeof value.message === "string",
  "EVM token provider error evidence is malformed.");
}

function validateTokenEvidence(token: EvmTokenContractEvidence): void {
  assert(isRecord(token), "EVM token evidence is malformed.");
  assert(token.schemaVersion === TOKEN_EVIDENCE_SCHEMA, "EVM token evidence schema version is unsupported.");
  assert(isRecord(token.provenance), "EVM token provenance is malformed.");
  assert(token.provenance.provider === "alchemy", "EVM token provider provenance is inconsistent.");
  assert(typeof token.provenance.fetchedAt === "string" && token.provenance.fetchedAt.length > 0
    && Number.isFinite(Date.parse(token.provenance.fetchedAt)), "EVM token fetch timestamp is malformed.");

  const block: unknown = token.provenance.observationBlock;
  assert(isRecord(block) && typeof block.status === "string", "EVM observation block evidence is malformed.");
  if (block.status === "available") {
    assert(hasExactKeys(block, ["status", "blockNumber", "basis"])
      && block.basis === "eth_blockNumber"
      && parseCanonicalHexBlock(block.blockNumber) !== null,
    "EVM available observation block evidence is malformed.");
  } else if (block.status === "provider_error") {
    assert(hasExactKeys(block, ["status", "blockNumber", "error"]) && block.blockNumber === null,
      "EVM provider-error block evidence is malformed.");
    assertProviderErrorEvidence(block.error);
  } else if (block.status === "malformed") {
    assert(hasExactKeys(block, ["status", "blockNumber", "reason"])
      && block.blockNumber === null && block.reason === "malformed_response",
    "EVM malformed block evidence is malformed.");
  } else {
    throw new EvmHolderStructureInputError("EVM observation block evidence is malformed.");
  }

  const code: unknown = token.contractCode;
  assert(isRecord(code) && typeof code.status === "string", "EVM contract-code evidence is malformed.");
  if (code.status === "present") {
    assert(hasExactKeys(code, ["status", "byteLength", "basis"])
      && code.basis === "eth_getCode" && Number.isSafeInteger(code.byteLength) && (code.byteLength as number) > 0,
    "EVM present contract-code evidence is malformed.");
  } else if (code.status === "no_code") {
    assert(hasExactKeys(code, ["status", "byteLength", "basis"])
      && code.byteLength === 0 && code.basis === "eth_getCode",
    "EVM no-code evidence is malformed.");
  } else if (code.status === "not_attempted") {
    assert(hasExactKeys(code, ["status", "reason"]) && code.reason === "block_unavailable",
      "EVM not-attempted contract-code evidence is malformed.");
  } else if (code.status === "provider_error") {
    assert(hasExactKeys(code, ["status", "error"]), "EVM provider-error contract-code evidence is malformed.");
    assertProviderErrorEvidence(code.error);
  } else if (code.status === "rpc_error") {
    assert(hasExactKeys(code, ["status", "rpcCode"]) && Number.isSafeInteger(code.rpcCode),
      "EVM RPC-error contract-code evidence is malformed.");
  } else if (code.status === "malformed") {
    assert(hasExactKeys(code, ["status", "reason"]) && code.reason === "malformed_response",
      "EVM malformed contract-code evidence is malformed.");
  } else {
    throw new EvmHolderStructureInputError("EVM contract-code evidence is malformed.");
  }

  const supply: unknown = token.totalSupply;
  assert(isRecord(supply) && typeof supply.status === "string", "EVM total-supply evidence is malformed.");
  if (supply.status === "available") {
    assert(hasExactKeys(supply, ["status", "value", "basis"])
      && supply.basis === "eth_call" && parseCanonicalUint256(supply.value) !== null,
    "EVM available total-supply evidence is malformed.");
  } else if (supply.status === "not_attempted") {
    assert(hasExactKeys(supply, ["status", "value", "reason"]) && supply.value === null
      && ["block_unavailable", "no_contract_code", "code_unavailable"].includes(String(supply.reason)),
    "EVM not-attempted total-supply evidence is malformed.");
  } else if (supply.status === "provider_error") {
    assert(hasExactKeys(supply, ["status", "value", "error"]) && supply.value === null,
      "EVM provider-error total-supply evidence is malformed.");
    assertProviderErrorEvidence(supply.error);
  } else if (supply.status === "rpc_error") {
    assert(hasExactKeys(supply, ["status", "value", "rpcCode"])
      && supply.value === null && Number.isSafeInteger(supply.rpcCode),
    "EVM RPC-error total-supply evidence is malformed.");
  } else if (supply.status === "malformed") {
    assert(hasExactKeys(supply, ["status", "value", "reason"]) && supply.value === null
      && ["malformed_response", "malformed_abi"].includes(String(supply.reason)),
    "EVM malformed total-supply evidence is malformed.");
  } else {
    throw new EvmHolderStructureInputError("EVM total-supply evidence is malformed.");
  }

  const blockAvailable = block.status === "available";
  const codeStatus = code.status;
  if (!blockAvailable) {
    assert(codeStatus === "not_attempted" && code.reason === "block_unavailable"
      && supply.status === "not_attempted" && supply.reason === "block_unavailable",
    "EVM token evidence outcomes contradict unavailable block evidence.");
  } else if (codeStatus === "not_attempted") {
    throw new EvmHolderStructureInputError("EVM token evidence outcomes contradict available block evidence.");
  } else if (codeStatus !== "present") {
    const expectedReason = codeStatus === "no_code" ? "no_contract_code" : "code_unavailable";
    assert(supply.status === "not_attempted" && supply.reason === expectedReason,
      "EVM token supply outcome contradicts contract-code evidence.");
  } else {
    assert(supply.status !== "not_attempted", "EVM token supply was not attempted despite available contract code.");
  }
}

function assertCompatibleIdentity(token: EvmTokenContractEvidence, holders: EvmHolderEvidence): string {
  validateTokenEvidence(token);
  assert(isRecord(holders), "EVM holder evidence is malformed.");
  assert((token.chain === "base" || token.chain === "ethereum") && token.chain === token.provenance.chain,
    "EVM token evidence chain provenance is inconsistent.");
  assert((holders.chain === "base" || holders.chain === "ethereum") && holders.chain === holders.provenance.chain,
    "EVM holder evidence chain provenance is inconsistent.");
  assert(token.chain === holders.chain, "EVM token and holder evidence chains do not match.");

  const tokenAddress = normalizeEvmAddress(token.contractAddress);
  const submittedTokenAddress = normalizeEvmAddress(token.submittedAddress);
  const holderAddress = normalizeEvmAddress(holders.tokenContractAddress);
  const holderProvenanceAddress = normalizeEvmAddress(holders.provenance.tokenContractAddress);
  assert(tokenAddress !== null && submittedTokenAddress !== null && holderAddress !== null && holderProvenanceAddress !== null,
    "EVM token or holder contract identity is malformed.");
  assert(tokenAddress === submittedTokenAddress && holderAddress === holderProvenanceAddress,
    "EVM token or holder contract provenance is inconsistent.");
  assert(tokenAddress === holderAddress, "EVM token and holder evidence contracts do not match.");
  const expectedSlug = token.chain === "base" ? "base-mainnet" : "eth-mainnet";
  assert(holders.provenance.provider === "goldrush" && holders.provenance.providerChainSlug === expectedSlug,
    "GoldRush holder provider chain provenance is inconsistent.");
  return tokenAddress;
}

type BlockComparability =
  | { comparable: true }
  | { comparable: false; reason: "alchemy_block_unavailable" | "goldrush_block_not_reported" | "observation_block_mismatch" };

function assessBlockComparability(token: EvmTokenContractEvidence, holders: EvmHolderEvidence): BlockComparability {
  if (token.provenance.observationBlock.status !== "available") return { comparable: false, reason: "alchemy_block_unavailable" };
  const alchemyBlock = parseCanonicalHexBlock(token.provenance.observationBlock.blockNumber);
  const requestedBlock = parseCanonicalDecimalBlock(holders.provenance.requestedObservationBlock);
  if (alchemyBlock === null || requestedBlock === null) return { comparable: false, reason: "observation_block_mismatch" };
  if (holders.provenance.providerBlockRelation === "not_reported"
    || holders.provenance.providerReportedObservationBlock === null) {
    return { comparable: false, reason: "goldrush_block_not_reported" };
  }
  const reportedBlock = parseCanonicalDecimalBlock(holders.provenance.providerReportedObservationBlock);
  if (holders.provenance.providerBlockRelation !== "match" || reportedBlock === null
    || alchemyBlock !== requestedBlock || reportedBlock !== requestedBlock) {
    return { comparable: false, reason: "observation_block_mismatch" };
  }
  return { comparable: true };
}

function validateHolderEvidence(holders: EvmHolderEvidence): EvmPositiveBalanceAddress[] {
  assert(holders.schemaVersion === HOLDER_EVIDENCE_SCHEMA, "EVM holder evidence schema version is unsupported.");
  assert(Array.isArray(holders.holders), "EVM holder rows are malformed.");
  assert(holders.pagination !== null && typeof holders.pagination === "object" && Array.isArray(holders.pagination.pages),
    "EVM holder pagination evidence is malformed.");
  assert(holders.coverage !== null && typeof holders.coverage === "object" && typeof holders.coverage.status === "string",
    "EVM holder coverage evidence is malformed.");
  const coverage = holders.coverage as unknown as Record<string, unknown>;
  if (coverage.status === "provider_complete") {
    assert(hasExactKeys(coverage, ["status"]), "EVM holder coverage state is malformed.");
  } else if (coverage.status === "partial") {
    assert(hasExactKeys(coverage, ["status", "reason"])
      && ["resource_limited", "provider_error", "malformed_response"].includes(String(coverage.reason)),
    "EVM holder coverage state is malformed.");
  } else if (coverage.status === "unavailable") {
    assert(hasExactKeys(coverage, ["status", "reason"]) && coverage.reason === "provider_error",
      "EVM holder coverage state is malformed.");
  } else if (coverage.status === "malformed") {
    assert(hasExactKeys(coverage, ["status", "reason"]) && coverage.reason === "malformed_response",
      "EVM holder coverage state is malformed.");
  } else {
    throw new EvmHolderStructureInputError("EVM holder coverage state is malformed.");
  }
  const pagination = holders.pagination;
  assert(Number.isSafeInteger(pagination.pagesRequested) && pagination.pagesRequested >= 0
    && Number.isSafeInteger(pagination.pagesReturned) && pagination.pagesReturned >= 0
    && Number.isSafeInteger(pagination.recordsRetained) && pagination.recordsRetained >= 0,
  "EVM holder pagination counts are malformed.");
  assert(pagination.providerRecordsReturned === null
    || Number.isSafeInteger(pagination.providerRecordsReturned) && pagination.providerRecordsReturned >= 0,
  "EVM provider record count is malformed.");
  for (const page of pagination.pages) {
    assert(page !== null && typeof page === "object"
      && Number.isSafeInteger(page.requestedPageNumber) && page.requestedPageNumber >= 0
      && Number.isSafeInteger(page.providerRecordsReturned) && page.providerRecordsReturned >= 0
      && Number.isSafeInteger(page.recordsRetained) && page.recordsRetained >= 0
      && page.providerReportedPageSize === 100
      && typeof page.providerHasMore === "boolean",
    "EVM holder page evidence is malformed.");
  }
  assert(Number.isSafeInteger(holders.observedHolderRecordCount) && holders.observedHolderRecordCount === holders.holders.length,
    "EVM holder record count does not match retained rows.");
  assert(Number.isSafeInteger(holders.pagination.recordsRetained) && holders.pagination.recordsRetained === holders.holders.length,
    "EVM retained-record count does not match retained rows.");
  assert(Number.isSafeInteger(holders.observedPositiveBalanceAddressCount), "EVM positive-address count is malformed.");

  const seen = new Set<string>();
  const positive: EvmPositiveBalanceAddress[] = [];
  for (const row of holders.holders) {
    assert(row !== null && typeof row === "object", "EVM holder row is malformed.");
    const address = normalizeEvmAddress(row.address);
    const balance = parseCanonicalUint256(row.rawBalance);
    assert(address !== null && balance !== null, "EVM holder address or raw balance is malformed.");
    assert(!seen.has(address), "EVM holder evidence contains duplicate normalized addresses.");
    seen.add(address);
    if (balance > 0n) positive.push({ address, balanceRaw: balance.toString(10) });
  }
  assert(holders.observedPositiveBalanceAddressCount === positive.length,
    "EVM positive-address count does not match positive balances.");

  positive.sort((left, right) => {
    const leftBalance = BigInt(left.balanceRaw);
    const rightBalance = BigInt(right.balanceRaw);
    return leftBalance === rightBalance
      ? left.address < right.address ? -1 : left.address > right.address ? 1 : 0
      : leftBalance > rightBalance ? -1 : 1;
  });
  return positive;
}

function isProviderPaginationComplete(holders: EvmHolderEvidence): boolean {
  const pagination = holders.pagination;
  if (holders.coverage.status !== "provider_complete"
    || holders.failure !== null
    || pagination.terminalReason !== "natural_termination"
    || pagination.providerHasMore !== false
    || pagination.pages.length === 0
    || !Number.isSafeInteger(pagination.maxPages) || pagination.maxPages <= 0
    || !Number.isSafeInteger(pagination.maxRecords) || pagination.maxRecords <= 0
    || pagination.requestedPageSize !== 100
    || pagination.providerReportedPageSize !== 100
    || pagination.pages.length > pagination.maxPages
    || pagination.pagesRequested !== pagination.pages.length
    || pagination.pagesReturned !== pagination.pages.length
    || pagination.providerRecordsReturned === null
    || pagination.providerRecordsReturned > pagination.maxRecords
    || pagination.providerRecordsReturned !== pagination.pages.reduce((sum, page) => sum + page.providerRecordsReturned, 0)
    || pagination.recordsRetained !== pagination.pages.reduce((sum, page) => sum + page.recordsRetained, 0)) {
    return false;
  }
  if (holders.failure !== null || holders.providerReportedHolderCount !== pagination.providerReportedHolderCount) return false;
  const reportedCount = pagination.providerReportedHolderCount === null
    ? null : parseCanonicalDecimalBlock(pagination.providerReportedHolderCount);
  if (pagination.providerReportedHolderCount !== null && reportedCount === null) return false;
  return pagination.pages.every((page, index) => page.requestedPageNumber === index
      && page.providerRecordsReturned <= 100
      && page.recordsRetained <= page.providerRecordsReturned
      && page.providerHasMore === (index < pagination.pages.length - 1))
    && pagination.pages.at(-1)?.providerHasMore === false
    && (reportedCount === null || reportedCount === BigInt(pagination.providerRecordsReturned));
}

function unavailableConcentration(
  topN: 1 | 5 | 10 | 20,
  numeratorRaw: string,
  denominatorRaw: string | null,
  reason: Exclude<EvmTopNSupplyConcentration, { status: "available" }> ["reason"],
): EvmTopNSupplyConcentration {
  return { status: "unavailable", topN, numeratorRaw, denominatorRaw, denominatorBasis: "total_supply", percentage: null, reason };
}

function percentageHalfUp(numerator: bigint, denominator: bigint): string {
  const scale = 1_000_000n;
  const scaled = (numerator * 100n * scale + denominator / 2n) / denominator;
  return `${(scaled / scale).toString(10)}.${(scaled % scale).toString(10).padStart(6, "0")}`;
}

/**
 * Derives deterministic raw address-level structure from existing Alchemy and GoldRush evidence.
 * Concentration requires comparable blocks, valid nonzero exact supply, explicit GoldRush pagination
 * completion, internally reconciled page/count evidence, and observed positive balances exactly
 * equal to supply. This does not claim blockchain-complete ownership or economic ownership.
 */
export function normalizeEvmHolderStructure(
  token: EvmTokenContractEvidence,
  holders: EvmHolderEvidence,
): EvmHolderStructure {
  const tokenContractAddress = assertCompatibleIdentity(token, holders);
  const ranked = validateHolderEvidence(holders);
  const observedTotal = ranked.reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n);
  const observedPositiveBalanceRaw = observedTotal.toString(10);
  const block = assessBlockComparability(token, holders);

  let supply: bigint | null = null;
  let supplyIssue: "total_supply_unavailable" | "total_supply_malformed" | null = null;
  const supplyFact: unknown = token.totalSupply;
  if (supplyFact !== null && typeof supplyFact === "object" && "status" in supplyFact
    && supplyFact.status === "available" && "value" in supplyFact && "basis" in supplyFact
    && supplyFact.basis === "eth_call") {
    supply = parseCanonicalUint256(supplyFact.value);
  } else if (supplyFact !== null && typeof supplyFact === "object" && "status" in supplyFact
    && (supplyFact.status === "malformed" || supplyFact.status === "available")) {
    supplyIssue = "total_supply_malformed";
  } else {
    supplyIssue = "total_supply_unavailable";
  }
  if (supply === null && supplyIssue === null) supplyIssue = "total_supply_malformed";

  let reconciliation: EvmSupplyReconciliation;
  if (!block.comparable) {
    reconciliation = {
      status: "not_comparable",
      observedPositiveBalanceRaw,
      totalSupplyRaw: supply?.toString(10) ?? null,
      reason: block.reason,
    };
  } else if (supply === null) {
    reconciliation = {
      status: "unknown",
      observedPositiveBalanceRaw,
      totalSupplyRaw: null,
      reason: supplyIssue ?? "total_supply_malformed",
    };
  } else {
    reconciliation = {
      status: observedTotal === supply ? "reconciled" : observedTotal < supply ? "less_than_supply" : "greater_than_supply",
      observedPositiveBalanceRaw,
      totalSupplyRaw: supply.toString(10),
      basis: "observed_positive_balance_addresses_vs_total_supply",
    };
  }

  const numeratorFor = (topN: number): string => ranked.slice(0, topN)
    .reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n).toString(10);
  const topNBalanceNumeratorsRaw = {
    top1: numeratorFor(1),
    top5: numeratorFor(5),
    top10: numeratorFor(10),
    top20: numeratorFor(20),
  };

  const concentrationFor = (topN: typeof TOP_N[number]): EvmTopNSupplyConcentration => {
    const numeratorRaw = topNBalanceNumeratorsRaw[`top${topN}` as keyof typeof topNBalanceNumeratorsRaw];
    const denominatorRaw = supply?.toString(10) ?? null;
    if (!block.comparable) return unavailableConcentration(topN, numeratorRaw, denominatorRaw, block.reason);
    if (supply === null) return unavailableConcentration(topN, numeratorRaw, null, supplyIssue ?? "total_supply_malformed");
    if (supply === 0n) return unavailableConcentration(topN, numeratorRaw, denominatorRaw, "zero_supply");
    if (!isProviderPaginationComplete(holders)) {
      return unavailableConcentration(topN, numeratorRaw, denominatorRaw, "holder_coverage_incomplete");
    }
    if (reconciliation.status !== "reconciled") {
      return unavailableConcentration(topN, numeratorRaw, denominatorRaw, "supply_not_reconciled");
    }
    return {
      status: "available",
      topN,
      numeratorRaw,
      denominatorRaw: supply.toString(10),
      denominatorBasis: "total_supply",
      percentage: percentageHalfUp(BigInt(numeratorRaw), supply),
    };
  };

  return {
    chain: token.chain,
    tokenContractAddress,
    observedHolderRecordCount: holders.observedHolderRecordCount,
    balanceBearingAddressCount: ranked.length,
    observedPositiveBalanceRaw,
    goldRushCoverage: holders.coverage,
    rankedBalanceBearingAddresses: ranked,
    supplyReconciliation: reconciliation,
    topNBalanceNumeratorsRaw,
    topNSupplyConcentration: {
      top1: concentrationFor(1),
      top5: concentrationFor(5),
      top10: concentrationFor(10),
      top20: concentrationFor(20),
    },
  };
}
